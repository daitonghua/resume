// PDF 排版层：传统单栏简历。
// 关键点：一份简历里中/俄/英会混排（如"博士 — HSE 大学"），pdfkit 单次 text() 只能用一个字体，
// 所以要按码点做"字体路由"：拉丁+西里尔 → Arial（有真 Bold），CJK → SimHei（标题）/ Deng（正文）。
// 中文不需要字重文件：SimHei 本身就是黑体，标题层次靠"换字族"实现，嵌入子集后整份 PDF 仅几十 KB。
import { existsSync } from "node:fs";
import { sectionOf, visibleSections } from "./render.mjs";

/* ============================ 字体 ============================ */
const WIN = "C:/Windows/Fonts";
export const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const isCJK = (ch) => CJK_RE.test(ch);

const CANDIDATES = {
  latin:     [`${WIN}/arial.ttf`, `${WIN}/segoeui.ttf`, `${WIN}/calibri.ttf`],
  latinBold: [`${WIN}/arialbd.ttf`, `${WIN}/segoeuib.ttf`, `${WIN}/calibrib.ttf`],
  latinIt:   [`${WIN}/ariali.ttf`, `${WIN}/segoeuii.ttf`, `${WIN}/calibrii.ttf`],
  cjk:       [`${WIN}/Deng.ttf`, `${WIN}/NotoSansSC-VF.ttf`, `${WIN}/simhei.ttf`],
  cjkBold:   [`${WIN}/simhei.ttf`, `${WIN}/Dengb.ttf`, `${WIN}/msyhbd.ttc`],
};

export function resolveFonts() {
  const found = {};
  const missing = [];
  for (const [key, list] of Object.entries(CANDIDATES)) {
    const hit = list.find((p) => existsSync(p));
    if (hit) found[key] = hit; else missing.push(key);
  }
  return { fonts: found, missing };
}

// PICK(key, bold, italic)：key 是"字体族键"，取值只能是 "cjk" / "latin"。
// 曾经的 bug：这里写成 if (isCJK(key)) —— isCJK 判断的是"单个字符是否为汉字"，
// 对 "cjk" 这个三字母字符串恒为 false，于是所有文本都被判成 latin，
// 汉字被交给 Arial（无 CJK 字形）→ 渲染成空白、PDF 的 ToUnicode 也不含这些汉字。
const PICK = (key, bold, italic) => {
  if (key === "cjk") return bold ? "cjkBold" : "cjk";
  return bold ? "latinBold" : italic ? "latinIt" : "latin";
};
const fontKeyFor = (ch, bold, italic) => PICK(isCJK(ch) ? "cjk" : "latin", bold, italic);

/* ============================ 样式 ============================ */
// 密度依据：A4 单页可用 495x752pt。按 8.9pt/13.1pt 行距测算，
// 一页约容纳 1900 个中文字符（或约 4800 个西文词元）。
// 各语言的实测密度见 tools/verify-pdf.mjs 的页数表。
export const S = {
  page: { size: "A4", margins: { top: 44, bottom: 46, left: 50, right: 50 } },
  size: {
    name: 18.4, role: 9.2, contact: 8.2, section: 11.2, entryTitle: 10.1, org: 9.1,
    body: 8.7, bullet: 8.7, fact: 8.5, pub: 8.2, chip: 8.2, small: 7.6, statValue: 11.4, statLabel: 8.0,
  },
  lineGap: 1.9,
  lead: 13.1,       // 行距基准：同段内所有字体共用，保证中英混排行高一致
  gap: { section: 11, entry: 7.5, block: 5, bullet: 2.1, para: 3, afterHead: 3.4, afterOrg: 2.8 },
  color: { ink: "#17191e", body: "#2b3038", mute: "#5f6672", faint: "#8a9099", rule: "#d9dce2", accent: "#1f4fd8" },
  bulletIndent: 10,
  ind: { left: 0 },
};

/* ============================ 内联标记 → 段 ============================ */
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&nbsp;": " ", "&emsp;": " ", "&mdash;": "—" };
const decode = (s) => s.replace(/&[a-z]+;|&#\d+;/gi, (m) => ENT[m] ?? (m.startsWith("&#") ? String.fromCodePoint(+m.slice(2, -1)) : m));

/** 解析 <strong>/<em>/<br> 与少量实体，输出 [{text,bold,italic}] */
export function inlineSegments(html) {
  const out = [];
  let bold = 0, italic = 0;
  const push = (t) => {
    const text = decode(t);
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.bold === !!bold && last.italic === !!italic) last.text += text;
    else out.push({ text, bold: !!bold, italic: !!italic });
  };
  const re = /<(\/?)(strong|em|b|i|br)\s*\/?>/gi;
  let idx = 0, m;
  while ((m = re.exec(html))) {
    push(html.slice(idx, m.index));
    const [, close, tag] = m;
    const t = tag.toLowerCase();
    if (t === "br") push("\n");
    else if (t === "strong" || t === "b") bold += close ? -1 : 1;
    else italic += close ? -1 : 1;
    idx = re.lastIndex;
  }
  push(html.slice(idx));
  return out.length ? out : [{ text: "", bold: false, italic: false }];
}

/** 按换行拆成"行组"，每个行组是若干段（用于支持 <br>） */
function lineGroups(html) {
  const segs = inlineSegments(html);
  const groups = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) groups.push([]);
      if (p) groups[groups.length - 1].push({ ...s, text: p });
    });
  }
  return groups.filter((g) => g.length);
}

/* ============================ 文本度量与换行 ============================ */

/** 把行组按宽度折成 [{segs:[{text,font}]}] */
function wrapGroups(doc, groups, width, bold) {
  const lines = [];
  for (const group of groups) {
    const runs = [];
    for (const s of group) {
      // 按字符所属字体切分 run。
      // 注意：缓冲区必须绑定字体键，键一变就先冲刷——否则 "AI " 会和后面的汉字
      // 合成一个 run 并沿用前一个键，导致汉字被交给 Arial（无 CJK 字形）→ 输出空白码。
      let buf = "";
      let bufKey = null;
      for (const ch of s.text) {
        const k = fontKeyFor(ch, s.bold || bold, s.italic);
        if (k !== bufKey) {
          if (buf) runs.push({ text: buf, key: bufKey });
          buf = ch; bufKey = k;
        } else buf += ch;
      }
      if (buf) runs.push({ text: buf, key: bufKey });
    }
    // 再按"不可断点"切成词元；CJK 逐字可断
    const tokens = [];
    for (const r of runs) {
      let buf = "";
      const flush = () => { if (buf) { tokens.push({ text: buf, key: r.key }); buf = ""; } };
      for (let i = 0; i < r.text.length; i++) {
        const ch = r.text[i];
        if (ch === " " || ch === "\t") {
          flush();
          if (tokens.length && !tokens[tokens.length - 1].space) tokens.push({ space: true, text: " ", key: r.key });
          continue;
        }
        if (isCJK(ch)) {
          flush();
          tokens.push({ text: ch, key: r.key });
          continue;
        }
        buf += ch;
      }
      flush();
    }
    const wOf = (t, key) => { doc.font(key).fontSize(doc.__fs); return doc.widthOfString(t); };

    let cur = [];
    let curW = 0;
    const flushLine = () => { if (cur.length) lines.push(cur); cur = []; curW = 0; };
    for (const tk of tokens) {
      const w = tk.space ? doc.font(tk.key).fontSize(doc.__fs).widthOfString(" ") : wOf(tk.text, tk.key);
      if (tk.space && !cur.length) continue;             // 行首不留空格
      if (curW + w > width && cur.length) { flushLine(); if (tk.space) continue; }
      if (tk.space) { const last = cur[cur.length - 1];
        if (last) { last.text += " "; last.w += w; curW += w; } else { cur.push({ text: " ", key: tk.key, w }); curW += w; }
        continue; }
      const last = cur[cur.length - 1];
      if (last && last.key === tk.key) { last.text += tk.text; last.w += w; }
      else cur.push({ text: tk.text, key: tk.key, w });
      curW += w;
    }
    flushLine();
  }
  return lines;
}

/** 纯测量：给定宽度算出应占高度 */
function measure(doc, html, width, fs, leadOverride) {
  doc.__fs = fs;
  const lead = leadOverride ?? Math.max(S.lead, fs * 1.42);
  return wrapGroups(doc, lineGroups(html), width, false).length * lead;
}

/* ============================ 布局原语 ============================ */
const pageBottom = (doc) => doc.page.height - doc.page.margins.bottom;

function ensure(doc, h) {
  if (doc.y + h > pageBottom(doc)) { doc.addPage(); return true; }
  return false;
}

function drawLines(doc, lines, x, width, fs, opts = {}) {
  const lead = opts.lead ?? Math.max(S.lead, fs * 1.42);
  const color = opts.color ?? S.color.body;
  for (const line of lines) {
    const y = doc.y;
    // 关键：传了显式 x/y 就绝不能再传 continued。
    // 两者混用会让 PDFKit 的文本矩阵与 ToUnicode 偏移错位，
    // 结果是"看得见但提取不出来"——中文在 ATS 解析时整段丢失。
    // 所以每个 run 独立绘制在算术位置上。
    // width 给足余量，避免 PDFKit 在单 run 内再折行干扰坐标。
    let cx = x;
    for (const seg of line) {
      // 记录"实际绘制的文本"，供汉字可复制性校验使用。
      // 期望值必须来自渲染器真正绘制的文本，而不是从数据结构里"猜哪些字段会被渲染"——
      // 后者会把 note 这类不渲染的字段算进来，产生假失败（本项目踩过：误报 19 个汉字缺失）。
      // （绘制文本的上报已改为在 layout() 里统一包装 doc.text，见该函数注释）
      doc.font(seg.key).fontSize(fs).fillColor(color);
      doc.text(seg.text, cx, y, { lineGap: 0, width: Math.max(seg.w + 40, width) });
      cx += seg.w;
    }
    doc.y = y + lead;
  }
}

/**
 * 画一段富文本（会自动分页；保证"整段不被拆页"由调用方先用 measure 判断）
 * @returns 消耗的高度
 */
function para(doc, html, x, width, fs, opts = {}) {
  doc.__fs = fs;
  const lines = wrapGroups(doc, lineGroups(html), width, !!opts.bold);
  const lead = opts.lead ?? Math.max(S.lead, fs * 1.42);
  const h = lines.length * lead;
  ensure(doc, h);
  const startY = doc.y;
  drawLines(doc, lines, x, width, fs, { ...opts, lead });
  return doc.y - startY;
}

function rule(doc, x, width, gapBefore = 0, color = S.color.rule) {
  if (gapBefore) doc.y += gapBefore;
  ensure(doc, 3);
  doc.save().lineWidth(0.6).strokeColor(color)
    .moveTo(x, doc.y).lineTo(x + width, doc.y).stroke().restore();
}

function sectionHeader(doc, title, lang, opts = {}) {
  ensure(doc, 26);
  doc.y += S.gap.section;
  doc.font("cjkBold").fontSize(S.size.section).fillColor(S.color.accent);
  const isCjkTitle = CJK_RE.test(title);
  if (isCjkTitle) {
    doc.text(title, doc.page.margins.left, doc.y, { lineGap: 0 });
  } else {
    // 拉丁标题用小号大写 + 字距，更像正式简历
    doc.text(title.toUpperCase(), doc.page.margins.left, doc.y, { characterSpacing: 0.9, lineGap: 0 });
  }
  doc.y += 3;
  // 顶部分隔线。注：曾按"页头已有一条线，避免重复"的考虑让首个板块不画线，
  // 用户反馈那样"专业方向"与页头挤在一起、层级不清，故恢复为每个板块都画线。
  rule(doc, doc.page.margins.left, doc.page.width - doc.page.margins.left - doc.page.margins.right, 0);
  doc.y += S.gap.afterHead;
}

/** 左标题 + 右日期（日期右对齐，标题过长则换行） */
function entryHead(doc, title, date, fs = S.size.entryTitle) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const { width: dW } = (() => { doc.font("cjk").fontSize(S.size.fact); return { width: doc.widthOfString(date) }; })();
  const titleW = W - dW - 14;
  ensure(doc, 22);
  const y0 = doc.y;

  // 标题（可能折行）
  const tLines = (() => { doc.__fs = fs; return wrapGroups(doc, lineGroups(title), titleW, true); })();
  const lead = Math.max(S.lead, fs * 1.42);
  const savedY = doc.y;
  drawLines(doc, tLines, L, titleW, fs, { color: S.color.ink, bold: true, lead });
  const afterTitle = doc.y;
  doc.y = savedY;
  doc.font("cjk").fontSize(S.size.fact).fillColor(S.color.faint);
  doc.text(date, L, savedY + (tLines.length > 1 ? 0 : (lead - S.size.fact * 1.3) / 2), {
    width: W, align: "right", lineGap: 0,
  });
  doc.y = afterTitle;
  return doc.y - y0;
}

function bullet(doc, html, x, width) {
  const L = doc.page.margins.left;
  doc.__fs = S.size.bullet;
  const lines = wrapGroups(doc, lineGroups(html), width - S.bulletIndent, false);
  const lead = Math.max(S.lead, S.size.bullet * 1.42);
  const h = lines.length * lead;
  // 单条 bullet 过长时分页，让下一段整体挪到下一页（不撕裂 bullet）
  ensure(doc, h);
  const y = doc.y;
  doc.circle(x + 2.4, y + S.size.bullet * 0.62, 1.15).fillColor(S.color.faint).fill();
  drawLines(doc, lines, x + S.bulletIndent, width - S.bulletIndent, S.size.bullet, { lead });
  doc.y += S.gap.bullet;
}

function chipLine(doc, label, items) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const labelW = 62;
  const html = items.map((it) => {
    const note = it.note ? ` (${it.note})` : "";
    return `${it.name}${note}`;
  }).join("　");
  const w = W - labelW;
  doc.__fs = S.size.chip;
  const lines = wrapGroups(doc, lineGroups(html), w, false);
  const lead = Math.max(S.lead - 1.2, S.size.chip * 1.5);
  const h = Math.max(lines.length * lead, lead);
  ensure(doc, h + 3);
  const y = doc.y;
  doc.font("cjkBold").fontSize(S.size.small).fillColor(S.color.faint)
    .text(label, L, y + 1.2, { width: labelW, lineGap: 0 });
  doc.y = y;
  drawLines(doc, lines, L + labelW, w, S.size.chip, { lead, color: S.color.body });
  doc.y += 3;
}

/* ============================ 页头 / 页脚 ============================ */
function header(doc, name, role, contacts) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  doc.font("cjkBold").fontSize(S.size.name).fillColor(S.color.ink)
    .text(name, L, doc.y, { width: W, align: "center", lineGap: 0 });
  doc.y += 2;
  doc.font("cjk").fontSize(S.size.role).fillColor(S.color.accent)
    .text(role, L, doc.y, { width: W, align: "center", lineGap: 0 });
  doc.y += 5;
  // 联系方式：每行居中排列，用 · 分隔
  const chunks = [];
  let line = "";
  doc.__fs = S.size.contact;
  for (const c of contacts) {
    const trial = line ? `${line}   ·   ${c}` : c;
    if (doc.font("cjk").fontSize(S.size.contact).widthOfString(trial) > W - 20 && line) {
      chunks.push(line); line = c;
    } else line = trial;
  }
  if (line) chunks.push(line);
  for (const c of chunks) {
    doc.font("cjk").fontSize(S.size.contact).fillColor(S.color.mute)
      .text(c, L, doc.y, { width: W, align: "center", lineGap: 0 });
    doc.y += S.size.contact * 1.5;
  }
  doc.y += 2;
  rule(doc, L, W, 2, S.color.ink);
  doc.y += 2;
}

/** 画一行页脚。
 *  关键 1：只给显式 x/y，绝不给 width/align。
 *  doc.text() 一旦同时收到"显式坐标 + width/align"，pdfkit 会按 width 重新排版并按行数
 *  推进游标，越过页底就 addPage()——每写一次页脚多一张空白页（实测每份 PDF 多 1~2 页）。
 *  关键 2：**按字符选字体**。页脚含中文（姓名、版本名），若整行用 latin 字体（Arial 无 CJK 字形），
 *  汉字会渲染成方框 —— 用户报的"底部一堆方框"正是此因。
 *  关键 3：本函数覆盖页脚区域，tools/verify-cjk.mjs 必须把这里绘制的字符也纳入校验，
 *  否则页脚的中文渲染问题不会被任何检查发现（此前就是盲区）。 */
function footerLine(doc, str, x, y) {
  let cx = x;
  const runs = [];
  let buf = "", key = null;
  for (const ch of String(str)) {
    const k = fontKeyFor(ch, false, false);   // "cjk" 或 "latin"
    if (k !== key) { if (buf) runs.push({ text: buf, key }); buf = ch; key = k; }
    else buf += ch;
  }
  if (buf) runs.push({ text: buf, key });
  for (const r of runs) {
    doc.font(r.key).fontSize(S.size.small).fillColor(S.color.faint);
    doc.text(r.text, cx, y, { lineGap: 0, lineBreak: false });
    cx += doc.widthOfString(r.text);
  }
}

function footers(doc, text) {
  const range = doc.bufferedPageRange();
  const m = doc.page.margins;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const y = doc.page.height - m.bottom + 6;

    // 宽度用 CJK 字体测量：页脚含中文，用 latin 测会偏小导致溢到页码上
    const label = `${i - range.start + 1} / ${range.count}`;
    doc.font("latin").fontSize(S.size.small);
    const labelW = doc.widthOfString(label);
    doc.font("cjk").fontSize(S.size.small);
    let tag = text;
    while (tag.length > 1 && doc.widthOfString(tag) > W - labelW - 12) tag = tag.slice(0, -1);

    footerLine(doc, tag, L, y);
    footerLine(doc, label, L + W - labelW, y);
  }
}

/* ============================ 节点 → PDF ============================ */
/**
 * @param doc          PDFDocument 实例
 * @param data         简历数据
 * @param variantKey   版本 key
 * @param lang         语言
 * @param selectNodes  由 render.mjs 的 makeSelectNodes(data) 提供的选择器
 */
export function layout(doc, data, variantKey, lang, selectNodes, onNode) {
  const variant = data.variants[variantKey];
  const V = Object.assign({}, variant);

  // 把所有"实际绘制的文本"汇总给 onNode 之外的钩子（由 tools/verify-cjk.mjs 使用）。
  // 做法：直接包住 doc.text —— 而不是只在 drawLines() 里上报。
  // 原因：pdf.mjs 里有一批不经过 drawLines 的绘制（页脚、小节标题 sectionHeader、
  // 技能标签 chipLine、条目头 entryHead 的日期等）。此前只上报 drawLines，
  // 导致"页脚用 Arial 画中文 → 变方框"这类问题完全没被任何检查发现。
  const hook = doc.__onText;
  if (typeof hook === "function" && !doc.__textHooked) {
    const orig = doc.text.bind(doc);
    doc.text = function (t, ...rest) {
      if (typeof t === "string" && t.length) hook(t);
      return orig(t, ...rest);
    };
    doc.__textHooked = true;
  }

  // 紧凑模式：仅对"版式刚好溢出到第 2 页"的版本+语言启用
  // （英文比中文长，同样内容会多溢出一页；中文版不需要）。
  // 收紧板块间隔与行距把内容拉回一页；完整版不受影响。
  const saved = { gap: { ...S.gap }, lead: S.lead, size: { ...S.size } };
  // 方式二（绝对）：数据里直接给出目标参数值。用于"完整版压到 2 页"这类需要精确控制的场景——
  // 用相对比例层层相乘很难调准，直接给目标值更可靠。
  const cv = V.compactValues;
  if (cv) {
    if (cv.gap) Object.assign(S.gap, cv.gap);
    if (typeof cv.lead === "number") S.lead = cv.lead;
    if (cv.size) Object.assign(S.size, cv.size);
  }
  // 方式一（相对）：compactLangs —— 在基准值上按比例收紧
  const compact = !cv && (V.compact === true || (V.compactLangs ?? []).includes(lang));
  if (compact) {
    S.gap.section *= 0.62; S.gap.entry *= 0.68; S.gap.afterOrg *= 0.8; S.gap.bullet *= 0.85;
    S.lead *= 0.965;
  }
  try {
    return layoutInner(doc, data, variantKey, lang, selectNodes, onNode, V);
  } finally {
    Object.assign(S.gap, saved.gap); S.lead = saved.lead; Object.assign(S.size, saved.size);
  }
}

function layoutInner(doc, data, variantKey, lang, selectNodes, onNode, V) {
  const dropTags = new Set(V.dropTags ?? []);
  const keepAny = V.keepTagsAny;
  const maxLevel = V.maxLevel ?? 3;
  const keep = (item, base) => {
    if (item.tags && item.tags.some((t) => dropTags.has(t))) return false;
    if (keepAny?.length && item.tags && !item.tags.some((t) => keepAny.includes(t))) return false;
    return (item.level ?? base ?? 1) <= maxLevel;
  };

  const nodes = selectNodes(variantKey, lang);
  const secs = visibleSections(nodes, V, data);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;

  const p = data.profile;
  const contacts = p.links.map((l) => l.label[lang] ?? l.label.zh);
  if (p.location?.[lang]) contacts.push(p.location[lang]);
  header(doc, p.name[lang], p.title[lang], contacts);

  for (const [secIndex, sec] of secs.entries()) {
    const secNodes = nodes.filter((n) => sectionOf(n) === sec);
    const title = data.sections[sec].title[lang] ?? sec;
    let printedHeader = false;
    // secIndex === 0 → 首个板块，紧接页头，不画分隔线（页头已有一条，避免两条叠一起）
    const H = () => { if (!printedHeader) { sectionHeader(doc, title, lang, { first: secIndex === 0 }); printedHeader = true; } };

    for (const node of secNodes) {
      const __start = { y: doc.y, pages: doc.bufferedPageRange().count, page: doc.page };
      if (onNode) {
        // 传出去：渲染前后的 y、渲染前后的页数、以及"本节点实际所在页对象"与"结束页对象"。
        // 页号用 doc.page 对象在缓冲区里的下标来定（权威判据），不要用 bufferedPageRange().count
        // 推算——那个值在 addPage 前后的语义容易差一页。
        doc.__nodeHook = () => onNode({
          id: node.id, type: node.type,
          y0: __start.y, y1: doc.y,
          pagesBefore: __start.pages, pagesAfter: doc.bufferedPageRange().count,
          pageStart: __start.page, pageEnd: doc.page,
        });
      }
      switch (node.type) {
        case "bullet": {
          H();
          bullet(doc, node.text[lang], L, W);
          break;
        }
        case "skills": {
          H();
          for (const g of node.groups) {
            if (!keep(g, 1)) continue;
            chipLine(doc, g.area[lang] ?? g.area.zh, g.items.map((it) => ({
              name: it.name[lang] ?? it.name.zh,
              level: it.level,
              note: it.note?.[lang],
            })));
          }
          break;
        }
        case "job":
        case "research": {
          const blocks = (node.blocks ?? []).filter((b) => (b.bullets ?? []).some((x) => keep(x, node.level)));
          if (!blocks.length) continue;
          H();
          const headH = entryHead(doc, `${node.title[lang]} — ${node.org[lang]}`, node.date[lang]);
          if (node.link) {
            doc.font("latin").fontSize(S.size.small).fillColor(S.color.accent)
              .text(node.link.href, L, doc.y, { width: W, lineGap: 0 });
            doc.y += 2;
          }
          doc.y += S.gap.afterOrg;
          for (const b of blocks) {
            if (b.heading) {
              const hh = measure(doc, b.heading[lang], W, S.size.org) + 2;
              ensure(doc, hh + 14);
              doc.y += S.gap.block;
              para(doc, `<strong>${b.heading[lang]}</strong>`, L, W, S.size.org, { color: S.color.ink });
              doc.y += 1;
            }
            for (const x of (b.bullets ?? [])) {
              if (!keep(x, node.level)) continue;
              bullet(doc, x.text[lang], L, W);
            }
          }
          if (node.awards) {
            const h = measure(doc, `<strong>Awards:</strong> ${node.awards[lang]}`, W, S.size.fact);
            ensure(doc, h + 2);
            doc.y += 1.5;
            para(doc, `<strong>Awards:</strong> ${node.awards[lang]}`, L, W, S.size.fact, { color: S.color.mute });
          }
          doc.y += S.gap.entry;
          break;
        }
        case "edu": {
          H();
          entryHead(doc, `${node.degree[lang]} — ${node.school[lang]}`, node.date[lang], S.size.entryTitle);
          doc.y += S.gap.afterOrg - 1;
          const facts = [];
          // 专业与 GPA 同行显示（用户要求）：用「 · 」分隔，避免占两行
          const majorLine = [node.major?.[lang], node.gpa ? `GPA ${node.gpa}` : null].filter(Boolean).join(" · ");
          if (majorLine) facts.push(majorLine);
          if (node.thesis) facts.push(node.thesis[lang]);
          // 导师 / 联合培养项目：放在奖学金之前（用户要求的位置）
          if (node.advisor) facts.push(node.advisor[lang]);
          if (node.program) facts.push(node.program[lang]);
          if (node.scholarship) facts.push(node.scholarship[lang]);
          for (const f of facts) {
            const h = measure(doc, f, W, S.size.fact);
            ensure(doc, h);
            para(doc, f, L, W, S.size.fact, { color: S.color.mute });
          }
          doc.y += S.gap.entry - 2;
          break;
        }
        case "courses": {
          H();
          // 单一数组结构：总名用 pick(name, lang)，分名列表用 list[lang]。
          // 数据里 items 不再是"每语言一份副本"——那种结构下总名会串语言
          // （英文页面显示中文总名），而且一个字段要在 md 里出现三次。
          const groups = Array.isArray(node.items) ? node.items : [];
          const th = measure(doc, `<strong>${node.title[lang]}</strong>`, W, S.size.pub);
          ensure(doc, th + 8);
          para(doc, `<strong>${node.title[lang]}</strong>`, L, W, S.size.pub, { color: S.color.ink });
          doc.y += 0.5;
          for (const grp of groups) {
            // 总名与分名同一段，总名加粗并缩进 —— 既保住"总名/分名"的层级可读性，
            // 又比"总名单独成行"省一行（完整版要压进 2 页，行数很紧）。
            const name = grp.name?.[lang] ?? grp.name?.zh ?? "";
            const list = (grp.list?.[lang] ?? []).join(" · ");
            const h = measure(doc, `<strong>${name}</strong> — ${list}`, W - 12, S.size.pub);
            ensure(doc, h + 1);
            para(doc, `<strong>${name}</strong> — ${list}`, L + 12, W - 12, S.size.pub, { color: S.color.mute });
          }
          doc.y += S.gap.bullet;
          break;
        }
        case "competition": {
          H();
          const h = measure(doc, node.detail[lang], W, S.size.pub) +
                    measure(doc, node.name[lang], W, S.size.entryTitle) + 4;
          ensure(doc, h);
          para(doc, `<strong>${node.name[lang]}</strong>　${node.date[lang] ?? ""}`, L, W, S.size.entryTitle, { color: S.color.ink });
          doc.y += 1;
          para(doc, node.detail[lang], L, W, S.size.pub, { color: S.color.mute });
          doc.y += S.gap.entry - 3;
          break;
        }
        case "pubList": {
          const items = (node.items ?? []).filter((x) => keep(x, node.level));
          if (!items.length) continue;
          H();
          const hh = measure(doc, node.kind[lang], W, S.size.pub);
          ensure(doc, hh + 10);
          para(doc, `<strong>${node.kind[lang]}</strong>`, L, W, S.size.pub, { color: S.color.mute });
          doc.y += 1;
          items.forEach((x, i) => {
            const h = measure(doc, x.text[lang], W - 16, S.size.pub);
            ensure(doc, h + 1);
            const y = doc.y;
            doc.font("latin").fontSize(S.size.pub).fillColor(S.color.faint)
              .text(`[${i + 1}]`, L, y, { width: 16, lineGap: 0 });
            doc.y = y;
            para(doc, x.text[lang], L + 16, W - 16, S.size.pub, { lead: S.size.pub * 1.55 });
            doc.y += 1.2;
          });
          doc.y += S.gap.para;
          break;
        }
        default: break;
      }
      if (doc.__nodeHook) {
        doc.__nodeHook(doc.y, doc.bufferedPageRange().count);
        doc.__nodeHook = null;
      }
    }
  }

  // 页脚：姓名 + "简历更新于 日期"。
  // 不放版本名 —— 这份 PDF 就是一份正常简历，不需要出现"完整版（全部内容）"这类内部说法。
  // 标签按当前语言取，避免英文/俄文版里出现中文（会触发 verify-pdf 的语言串味检查）。
  const updLabel = { zh: "简历更新于", en: "Resume updated", ru: "Резюме обновлено" }[lang] ?? "简历更新于";
  const tag = `${p.name[lang]} · ${updLabel} ${data.meta.updated}`;
  footers(doc, tag);
}

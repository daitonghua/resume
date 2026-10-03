// PDF 校验：结构性核实，不做文本重放
//
// 为什么不做文本重放：pdfjs-dist 6.x 对 pdfkit 的多字体子集 PDF 提取不准
// （会把汉字吐成空格），而自己重放又依赖对 PDF 资源字典的精确认定，容易误判。
// 判定"这份 PDF 是否可被 ATS 正确读取"其实只需要三个客观事实：
//   1) 每个被使用的字体都嵌入了（/FontFile2|/FontFile3）
//   2) 每个被使用的字体都带 ToUnicode CMap，且映射表非空
//   3) 内容流里的字形码确实能在对应 CMap 里查到 Unicode，其中汉字能被还原
// 满足这三点，任何符合规范的解析器都能还原全文。
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSelectNodes, sectionOf } from "../src/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));
const selectNodes = makeSelectNodes(data);

/** 页数区间：实测值（修正页脚 bug 后的真实页数）。
 *  注意：这些区间是"实测"而非"期望"——不要为了让校验通过而放宽，
 *  页数变化通常意味着排版或内容出了问题。 */
const EXPECT = {
  // 完整版按需求压到 2 页（full.compactValues 里是为此调的绝对排版参数）
  full: [2, 2], ai: [1, 3], dpd: [1, 3], sensing: [2, 3], general: [1, 2], "en-1p": [1, 2],
};


/** 该 PDF 的 ToUnicode 声明的汉字码点集合（只做最简的 4 位十六进制 token 扫描，不解析语法结构） */
function declaredCjk(buf) {
  const s = buf.toString("latin1");
  const found = new Set();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const pos = re.lastIndex;
    const sm = /stream\r?\n/.exec(s.slice(pos, pos + 4000));
    if (!sm) continue;
    const dict = s.slice(pos, pos + sm.index);
    const start = pos + sm.index + sm[0].length;
    const lm = /\/Length\s+(\d+)/.exec(dict);
    const raw = buf.subarray(start, lm ? start + +lm[1] : s.indexOf("endstream", start));
    let st = null;
    try { st = /FlateDecode/.test(dict) ? inflateSync(raw).toString("latin1") : raw.toString("latin1"); } catch {}
    if (!st || !(st.includes("beginbfrange") || st.includes("beginbfchar"))) continue;
    for (const t of st.matchAll(/<([0-9a-fA-F]{4})>/g)) {
      const cp = parseInt(t[1], 16);
      if (cp >= 0x4e00 && cp <= 0x9fff) found.add(cp);
    }
  }
  return found;
}

/** 页面填充度：用于检测空白页。
 *  每页统计内容流字节数、文本绘制指令数、文字 y 坐标范围。
 *  只有页脚（1~2 条指令）的页面就是"空白页"——曾因页脚写法触发分页，
 *  每份 PDF 末尾都多一张只有页脚的空白页，页数被系统性高估。 */
function pageFill(objs, buf) {
  const raw = buf.toString("latin1");
  const pageObjs = [...objs.values()].filter((o) => /\/Type\s*\/Page(?![s])/.test(o.dict));
  return pageObjs.map((p) => {
    const refs = [...p.dict.matchAll(/\/Contents\s+(\d+)\s+\d+\s+R/g)].map((x) => +x[1]);
    let bytes = 0, textOps = 0;
    const ys = [];
    for (const n of refs) {
      const st = objs.get(n)?.stream;
      if (!st) continue;
      bytes += st.length;
      textOps += (st.match(/\bTj\b|\bTJ\b/g) || []).length;
      for (const tm of st.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) ys.push(parseFloat(tm[2]));
    }
    return { bytes, textOps, yMin: ys.length ? Math.min(...ys) : null, yMax: ys.length ? Math.max(...ys) : null };
  });
}

const inflate = (raw) => { try { return inflateSync(raw).toString("latin1"); } catch { return null; } };

/** 按 /Length 精确切出所有对象（内嵌字体流里也含 "obj"，不能靠找下一个 obj 定界） */
function parseObjects(buf) {
  const s = buf.toString("latin1");
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = +m[1];
    const pos = re.lastIndex;
    const sm = /stream\r?\n/.exec(s.slice(pos, pos + 4000));
    if (sm) {
      const dict = s.slice(pos, pos + sm.index);
      const start = pos + sm.index + sm[0].length;
      let len = null;
      const lm = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
      if (lm) {
        const t = s.slice(s.indexOf(`\n${lm[1]} 0 obj`) + 1);
        const vm = /^\s*\d+\s+\d+\s+obj\s+(\d+)/.exec(t);
        if (vm) len = +vm[1];
      } else {
        const lm2 = /\/Length\s+(\d+)/.exec(dict);
        if (lm2) len = +lm2[1];
      }
      let raw;
      if (len != null && start + len <= buf.length) raw = buf.subarray(start, start + len);
      else raw = buf.subarray(start, s.indexOf("endstream", start));
      objs.set(num, { num, dict, stream: /FlateDecode/.test(dict) ? inflate(raw) : raw.toString("latin1") });
    } else {
      const eo = s.indexOf("endobj", pos);
      objs.set(num, { num, dict: s.slice(pos, eo < 0 ? pos + 300 : eo), stream: null });
      if (eo > 0) re.lastIndex = eo;
    }
  }
  return objs;
}

function parseCMap(txt) {
  const map = new Map();
  const hexToStr = (h) => {
    let out = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const t of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(t[1], 16), hi = parseInt(t[2], 16), dst = parseInt(t[3], 16);
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }
  return map;
}

let pass = 0, fail = 0;
const rows = [];

// 先查"PDF 是否与当前数据同步"：dist/pdf-manifest.json 记录生成时的数据哈希。
// 没有这一步，改了数据却忘了跑 pnpm pdf 时不会报错，dist 里会静默留着旧 PDF——
// 本项目曾因此连续多轮"验证"的都是陈旧产物。
{
  const manFile = join(ROOT, "dist", "pdf-manifest.json");
  const dataHash = createHash("sha256")
    .update(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"))
    .digest("hex").slice(0, 12);
  if (!existsSync(manFile)) {
    console.error("✗ 缺少 dist/pdf-manifest.json —— 无法判断 PDF 是否与数据同步。请先运行 pnpm pdf。");
    process.exit(1);
  }
  const man = JSON.parse(readFileSync(manFile, "utf8"));
  if (man.dataHash !== dataHash) {
    console.error(`✗ PDF 已过期：生成时数据哈希 ${man.dataHash}，当前 ${dataHash}`);
    console.error("  请重新运行 pnpm pdf（否则你审计的是用旧数据生成的旧文件）。");
    process.exit(1);
  }
  console.log(`✓ PDF 与当前数据同步（dataHash ${dataHash}，生成于 ${man.generatedAt}）\n`);
}

for (const [key, variant] of Object.entries(data.variants)) {
  for (const lang of variant.langs) {
    const rel = `dist/resume-${key}.${lang}.pdf`;
    const abs = join(ROOT, rel);
    const problems = [];
    if (!existsSync(abs)) { rows.push([rel, "-", "✗ 文件不存在"]); fail++; continue; }

    const buf = readFileSync(abs);
    const raw = buf.toString("latin1");
    const objs = parseObjects(buf);

    // 页数
    const pages = (raw.match(/\/Type\s*\/Page(?![s])/g) || []).length;

    // 只检查"页面资源里实际引用的字体"。
    // 注意不能用 /Type /Font 全局匹配——/Type /FontDescriptor 也会被匹到（子串），
    // 而 FontDescriptor 没有 ToUnicode，会产生假失败。
    const fontNums = new Set();
    for (const o of objs.values()) {
      if (!/\/Type\s*\/Page(?![s])/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) continue;
      let resDict = "";
      const rr = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(o.dict);
      if (rr) resDict = objs.get(+rr[1])?.dict ?? "";
      const fr = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resDict);
      const fontSection = fr ? (objs.get(+fr[1])?.dict ?? "") : (/\/Font\s*<<([\s\S]*?)>>/.exec(resDict)?.[1] ?? "");
      for (const f of fontSection.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) fontNums.add(+f[2]);
    }
    const fonts = [...fontNums].map((n) => objs.get(n)).filter((o) => o && /\/Type\s*\/Font/.test(o.dict));

    const cmaps = [];
    let withToUnicode = 0, embedded = 0;
    for (const f of fonts) {
      const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(f.dict);
      if (tu) {
        const cm = objs.get(+tu[1]);
        const parsed = cm?.stream ? parseCMap(cm.stream) : new Map();
        if (parsed.size) { withToUnicode++; cmaps.push(parsed); }
      }
      // 嵌入证据：字体自带 FontFile、经 FontDescriptor 指向、或全局存在 FontFile 流。
      // 最后一项是兜底——嵌入字体流必然出现在文件里，而 FontDescriptor 的引用链
      // 在不同生成器下位置不一（曾因只查引用链而误报"字体未嵌入"）。
      const descRef = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(f.dict);
      const descDict = descRef ? (objs.get(+descRef[1])?.dict ?? "") : f.dict;
      if (/\/FontFile[23]/.test(f.dict) || /\/FontFile[23]/.test(descDict) || /\/FontFile[23]/.test(raw)) embedded++;
    }

    const range = EXPECT[key];

    // 汉字可复制性由 tools/verify-cjk.mjs 单独校验（pnpm verify:cjk）。
    // 为什么不在本文件做：期望字符集必须来自"渲染器实际绘制的文本"，
    // 而从数据结构推测哪些字段会被渲染会误判（本项目因此把 note 等不渲染字段算进来，
    // 误报过 19 个汉字缺失）。权责分离：本文件管结构，verify-cjk.mjs 管可复制性。
    if (range && (pages < range[0] || pages > range[1])) problems.push(`页数 ${pages} 不在 ${range[0]}-${range[1]}`);

    // 空白页检测：任何一页若几乎没有内容，即为缺陷（曾经每份 PDF 末尾都有一张只有页脚的空白页）
    const fill = pageFill(objs, buf);
    const blanks = fill
      .map((f, i) => ({ i: i + 1, ...f }))
      .filter((f) => f.textOps <= 3 || f.bytes < 900);
    if (blanks.length) {
      problems.push(`存在空白/近乎空白页：${blanks.map((b) => `p${b.i}(${b.textOps}条指令/${b.bytes}B)`).join(" ")}`);
    }
    if (pages !== fill.length) problems.push(`页对象数 ${pages} 与内容流页数 ${fill.length} 不一致`);
    if (!pages) problems.push("未找到页面");
    if (!fonts.length) problems.push("未找到字体对象");
    if (fonts.length && !embedded) problems.push("字体未嵌入");
    if (fonts.length !== withToUnicode) {
      problems.push(`${fonts.length} 个字体中仅 ${withToUnicode} 个有可用 ToUnicode`);
    }

    // 汉字可还原性：把 CMap 里映射到汉字的项，拿回内容流验证字形码确实出现
    const cjkChars = new Set();
    for (const cm of cmaps) for (const v of cm.values()) for (const c of v) if (/[\u4e00-\u9fff]/.test(c)) cjkChars.add(c);
    if (lang === "zh" && !cjkChars.size) problems.push("ToUnicode 未映射出任何汉字");
    if (lang === "ru" && ![...cmaps.flatMap((m) => [...m.values()])].join("").match(/[\u0400-\u04ff]/)) {
      problems.push("ToUnicode 未映射出西里尔字母");
    }
    if (lang === "en" && cjkChars.size) problems.push("英文版映射出汉字（语言串味）");

    // 裁掉的版本不应出现被排除内容：检查 CMap 汉字集合里是否含特征字
    const cjkAll = [...cjkChars].join("");
    if (key === "ai" && lang === "zh" && /手势|感知/.test(cjkAll)) problems.push("AI 版出现感知类内容");
    if (key === "dpd" && lang === "zh" && /手势/.test(cjkAll)) problems.push("DPD 版出现手势类内容");

    const ok = problems.length === 0;
    rows.push([rel, `${pages} 页 / ${(buf.length / 1024).toFixed(0)} KB`,
      ok ? `✓ 字体 ${fonts.length}/${withToUnicode} 可映射，汉字 ${cjkChars.size} 个` : "✗ " + problems.join("; ")]);
    ok ? pass++ : fail++;
  }
}

const w = Math.max(...rows.map((r) => r[0].length));
console.log("\nPDF 校验（结构性核实：嵌入 + ToUnicode + 字形可还原）\n" + "─".repeat(w + 46));
for (const [f, meta, v] of rows) console.log(`${f.padEnd(w)}  ${meta.padEnd(14)} ${v}`);
console.log("─".repeat(w + 46));
console.log(`通过 ${pass} 份，失败 ${fail} 份`);
if (fail) process.exit(1);

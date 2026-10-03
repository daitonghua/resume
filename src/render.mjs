// 渲染层：按节点 type 分发。同一 type 在任何语言、任何版本里都走同一个渲染器，
// 因此"多版本"只是裁剪，不存在内容重写 → 网站与 PDF 天然不会各说一套。

export const SECTIONS = [
  "competency", "skills",
  "experience", "research", "education", "competition", "publication",
];

export const LANG_LABEL = { zh: "中文", en: "English", ru: "Русский" };
export const LANG_SHORT = { zh: "中", en: "EN", ru: "RU" };
export const LANG_THEME = { zh: "#b91c1c", en: "#2563eb", ru: "#047857" };

/** 节点 → 所属板块 */
export function sectionOf(node) {
  switch (node.type) {
    case "bullet":      return "competency";
    case "skills":      return "skills";
    case "job":         return "experience";
    case "research":    return "research";
    case "edu":         return "education";
    case "competition": return "competition";
    case "pubList":     return "publication";
    case "courses":     return "education";
    default: throw new Error(`未知节点类型: ${node.type}`);
  }
}

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** 允许内联标签（strong/em/a）的富文本：先转义，再恢复白名单标签 */
function rich(s) {
  return esc(s)
    .replace(/&lt;(\/?)(strong|em|b|i)&gt;/g, "<$1$2>")
    .replace(/&lt;a href=&quot;([^&]*)&quot;&gt;/g, '<a href="$1" target="_blank" rel="noopener">')
    .replace(/&lt;\/a&gt;/g, "</a>");
}

const pick = (v, lang) => (v && typeof v === "object" ? v[lang] : v);

/* ============================ 裁剪逻辑 ============================ */

/**
 * 计算某语言 + 某版本下应该渲染的节点列表（已排序）。
 * 裁剪三条轴：
 *   1. dropNodes  —— 显式排除整个节点
 *   2. dropTags   —— 按主题排除节点（"AI 芯片版不要无线感知"）
 *   3. maxLevel   —— 按详略排除节点（level 3 = 课程级细节，1 页版一律砍）
 * 另外：keepTagsAny 是子条目级白名单；节点若被它清空（如 research.dpd 只剩被滤掉的子条目），
 * 则整节点一并去掉，避免出现"只有标题没有内容"的空壳条目。
 */
export function selectNodes(data, variantKey, lang) {
  const variant = data.variants[variantKey];
  if (!variant) throw new Error(`未知版本: ${variantKey}`);
  const dropNodes = new Set(variant.dropNodes ?? []);
  const dropTags = new Set(variant.dropTags ?? []);
  const maxLevel = variant.maxLevel ?? 3;

  const out = [];
  for (const id of data.order.default) {
    const node = data.nodes[id];
    if (!node) throw new Error(`order 引用了不存在的节点: ${id}`);
    if (dropNodes.has(id)) continue;
    if ((node.tags ?? []).some((t) => dropTags.has(t))) continue;
    if ((node.level ?? 1) > maxLevel) continue;
    if (isEmptied(node, variant)) continue;
    out.push({ id, ...node });
  }

  // 注意：这里的回调参数名不能叫 order，否则会遮蔽上面的板块顺序数组
  // （曾因此让 indexOf 始终返回 -1，板块顺序与节点归属全乱）
  const sectionRank = variant.sectionOrder ?? data.sectionOrder.default;
  out.sort((a, b) => sectionRank.indexOf(sectionOf(a)) - sectionRank.indexOf(sectionOf(b)));
  return out;
}

/** 节点在 keepTagsAny 白名单下是否已无任何可显示子条目 */
function isEmptied(node, variant) {
  const keepAny = variant?.keepTagsAny;
  if (!keepAny?.length) return false;
  const hits = (arr) => (arr ?? []).some((x) => (x.tags ?? []).some((t) => keepAny.includes(t)));
  switch (node.type) {
    // 必须有内容才有意义的条目：全部子 bullet 被滤掉 → 空壳，去掉
    case "job":
    case "research":
      return !(node.blocks ?? []).some((b) => hits(b.bullets));
    case "pubList":
      return !hits(node.items);
    default:
      return false;
  }
}

/** 该版本该语言下实际有内容的板块（保持声明顺序） */
export function visibleSections(nodes, variant, data) {
  const order = variant.sectionOrder ?? data.sectionOrder.default;
  const present = new Set(nodes.map(sectionOf));
  return order.filter((s) => present.has(s));
}

/**
 * 供 PDF 层使用的节点选择 API。
 * 不能把函数挂在 data 上（JSON 序列化会丢掉），必须由调用方以闭包传入。
 */
export function makeSelectNodes(data) {
  return (variantKey, lang) => selectNodes(data, variantKey, lang);
}

/** 子条目裁剪（bullets / blocks / items / skills 组） */
function keepItem(item, variant, minLevel) {
  const dropTags = new Set(variant?.dropTags ?? []);
  if (item.tags && item.tags.some((t) => dropTags.has(t))) return false;
  const keepAny = variant?.keepTagsAny;
  if (keepAny?.length && item.tags && !item.tags.some((t) => keepAny.includes(t))) return false;
  const maxLevel = variant?.maxLevel ?? 3;
  if ((item.level ?? minLevel) > maxLevel) return false;
  return true;
}

/* ============================ 各类型渲染 ============================ */

function renderHeader(data, lang) {
  const p = data.profile;
  const icons = {
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>',
    site: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>',
  };
  const meta = p.links.map((l) => {
    const label = pick(l.label, lang);
    const text = l.kind === "phone" ? label : label;
    return `<span>${icons[l.kind] ?? icons.site}<a href="${esc(l.href)}">${esc(text)}</a></span>`;
  }).join("");
  // 注意判的是"取值后是否为空"，不是"字段是否存在"：
  // location 现在可能是 {zh:"",en:"",ru:""}（存在但为空），按存在性判断会渲染出空标签。
  const locText = p.location ? pick(p.location, lang) : "";
  const loc = locText
    ? `<span>${icons.site}<span>${esc(locText)}</span></span>` : "";

  return `<header class="hdr">
  <div class="photo"><img src="daitonghua.jpg" alt="${esc(pick(p.name, lang))}"></div>
  <div class="hdr-info">
    <h1>${esc(pick(p.name, lang))}</h1>
    <div class="role">${esc(pick(p.title, lang))}</div>
    <div class="meta">${meta}${loc}</div>
  </div>
</header>`;
}





function renderBullets(node, lang) {
  // comp.core（核心能力）单独用高亮样式呈现，让招聘方一眼看到定位
  const cls = node.core ? ` class="bul core"` : ` class="bul"`;
  return `<ul${cls}><li>${rich(pick(node.text, lang))}</li></ul>`;
}

function renderSkills(node, variant, lang) {
  const groups = node.groups
    .filter((g) => keepItem(g, variant, 1))
    .map((g) => {
      const chips = g.items.map((it) => {
        const dots = [1, 2, 3, 4, 5]
          .map((n) => `<i class="${n <= it.level ? "f" : ""}"></i>`).join("");
        const note = it.note ? `<span class="note">${esc(pick(it.note, lang))}</span>` : "";
        return `<span class="chip"><span>${esc(pick(it.name, lang))}</span><span class="dots">${dots}</span>${note}</span>`;
      }).join("");
      return `<div class="skill-group">
        <div class="skill-area">${esc(pick(g.area, lang))}</div>
        <div class="skill-items">${chips}</div>
      </div>`;
    }).join("");
  return groups;
}

function entryHead(title, date, extraClass = "") {
  return `<div class="entry-head">
    <div class="t ${extraClass}">${title}</div>
    <div class="d">${date}</div>
  </div>`;
}

function renderJob(node, variant, lang) {
  const link = node.link
    ? ` · <a class="link-inline" href="${esc(node.link.href)}" target="_blank" rel="noopener">${esc(pick(node.link.label, lang))}</a>` : "";
  const blocks = (node.blocks ?? [])
    .filter((b) => keepItem(b, variant, node.level))
    .map((b) => {
      const heading = b.heading ? `<div class="block-h">${rich(pick(b.heading, lang))}</div>` : "";
      const bullets = (b.bullets ?? []).filter((x) => keepItem(x, variant, node.level));
      const list = bullets.length
        ? `<ul class="bul">${bullets.map((x) => `<li>${rich(pick(x.text, lang))}</li>`).join("")}</ul>` : "";
      if (!heading && !list) return "";
      return `<div class="block">${heading}${list}</div>`;
    }).filter(Boolean).join("");
  const awards = node.awards
    ? `<div class="award"><b>Awards:</b> ${esc(pick(node.awards, lang))}</div>` : "";
  return `<div class="entry">
    ${entryHead(esc(pick(node.title, lang)), esc(pick(node.date, lang)))}
    <div class="org">${esc(pick(node.org, lang))}${link}</div>
    ${blocks}${awards}
  </div>`;
}

function renderResearch(node, variant, lang) {
  const blocks = (node.blocks ?? []).map((b) => {
    const bullets = (b.bullets ?? []).filter((x) => keepItem(x, variant, node.level));
    return bullets.length
      ? `<div class="block"><ul class="bul">${bullets.map((x) => `<li>${rich(pick(x.text, lang))}</li>`).join("")}</ul></div>`
      : "";
  }).join("");
  return `<div class="entry">
    ${entryHead(esc(pick(node.title, lang)), esc(pick(node.date, lang)))}
    <div class="org">${esc(pick(node.org, lang))}</div>
    ${blocks}
  </div>`;
}

function renderEdu(node, variant, lang) {
  const facts = [];
  // 专业与 GPA 同行（与 PDF 渲染保持一致）
  const majorLine = [pick(node.major, lang), node.gpa ? `GPA ${node.gpa}` : null].filter(Boolean).join(" · ");
  if (majorLine) facts.push(`<div class="fact">${esc(majorLine)}</div>`);
  if (node.thesis) facts.push(`<div class="fact">${esc(pick(node.thesis, lang))}</div>`);
  // 导师 / 联合培养项目：按用户要求放在奖学金之前
  if (node.advisor) facts.push(`<div class="fact">${esc(pick(node.advisor, lang))}</div>`);
  if (node.program) facts.push(`<div class="fact">${esc(pick(node.program, lang))}</div>`);
  if (node.scholarship) facts.push(`<div class="fact">${esc(pick(node.scholarship, lang))}</div>`);
  return `<div class="entry">
    ${entryHead(esc(pick(node.degree, lang)), esc(pick(node.date, lang)))}
    <div class="org">${esc(pick(node.school, lang))}</div>
    ${facts.join("")}
  </div>`;
}

function renderCourses(node, variant, lang) {
  // 两级结构：总名独立一行（加粗小标题），分名缩进列出。
  // 这样"数学分析"与它下面的四门课、"其他数学课程"与它下面的六门课能看出归属。
  // 单一数组结构（items: [{name:{zh,en,ru}, list:{zh:[],en:[],ru:[]}}]）。
  // 早期是 items.{zh,en,ru} 三份副本，总名对象里混着三种语言、靠"哪份在前"决定语言，
  // 结果英文/俄文页面显示中文总名 —— 用户报的"区分不出来"就是这个。
  const groups = Array.isArray(node.items) ? node.items : [];
  const body = groups.map((grp) => `
    <div class="course-group">
      <div class="course-name">${esc(pick(grp.name, lang))}</div>
      <div class="course-list">${(grp.list?.[lang] ?? []).map(esc).join(" · ")}</div>
    </div>`).join("");
  return `<details class="courses"><summary>${esc(pick(node.title, lang))}</summary>
    <div class="body">${body}</div>
  </details>`;
}

function renderCompetition(node, variant, lang) {
  return `<div class="comp-item">
    <div class="n">${rich(pick(node.name, lang))}<span class="yr">${esc(pick(node.date, lang) ?? "")}</span></div>
    <div class="dt">${rich(pick(node.detail, lang))}</div>
  </div>`;
}

function renderPubList(node, variant, lang) {
  const items = (node.items ?? []).filter((x) => keepItem(x, variant, node.level));
  if (!items.length) return "";
  const list = items.map((x) => `<li>${rich(pick(x.text, lang))}</li>`).join("");
  return `<div class="pub-kind">${esc(pick(node.kind, lang))}</div><ol class="pubs">${list}</ol>`;
}

/* ============================ 总入口 ============================ */

const RENDERERS = {
  bullet:    (n, v, l, d) => renderBullets(n, l),
  skills:    (n, v, l, d) => renderSkills(n, v, l),
  job:       (n, v, l, d) => renderJob(n, v, l),
  research:  (n, v, l, d) => renderResearch(n, v, l),
  edu:       (n, v, l, d) => renderEdu(n, v, l),
  courses:   (n, v, l, d) => renderCourses(n, v, l),
  competition: (n, v, l, d) => renderCompetition(n, v, l),
  pubList:   (n, v, l, d) => renderPubList(n, v, l),
};

/** 渲染某语言 + 某版本的正文（不含控制条/页脚） */
export function renderBody(data, variantKey, lang) {
  const variant = data.variants[variantKey];
  const nodes = selectNodes(data, variantKey, lang);
  const secs = visibleSections(nodes, variant, data);
  const parts = [];
  for (const sec of secs) {
    const secTitle = pick(data.sections[sec].title, lang);
    const inner = nodes.filter((n) => sectionOf(n) === sec)
      .map((n) => RENDERERS[n.type](n, variant, lang, data))
      .filter((html) => html && html.trim())
      .join("\n");
    if (!inner.trim()) continue;
    parts.push(`<section class="section" data-section="${sec}">
  <h2>${esc(secTitle)}</h2>
  ${inner}
</section>`);
  }
  return renderHeader(data, lang) + "\n" + parts.join("\n");
}

export function renderFooter(data, variantKey, lang) {
  const variant = data.variants[variantKey];
  // 标签按 当前语言 → zh → en → key 回退，绝不输出 undefined
  // （曾因某版本只写了 zh/en 标签，俄文页脚渲染成 "Дай Тунхуа · undefined"）
  const label = pick(variant.label, lang) || variant.label?.zh || variant.label?.en || variantKey;
  const left = `${pick(data.profile.name, lang) || data.profile.name?.zh || ""} · ${esc(label)}`;
  const right = lang === "zh"
    ? `更新于 ${data.meta.updated}`
    : lang === "ru" ? `Обновлено ${data.meta.updated}` : `Updated ${data.meta.updated}`;
  return `<footer class="footer"><span>${left}</span><span>${right}</span></footer>`;
}

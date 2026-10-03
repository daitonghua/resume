// 数据校验：保证单一数据源不会因为手改 JSON 而静默出错
import { LANG_LABEL, SECTIONS, sectionOf } from "../src/render.mjs";

const LANGS = Object.keys(LANG_LABEL);

/** 需要覆盖全部语言的内容字段（缺一个语言就会在切换时显示错误或空白） */
const LANG_FIELDS = {
  bullet: ["text"],
  skills: [],
  job: ["title", "org", "date"],
  research: ["title", "org", "date"],
  edu: ["degree", "school", "date"],
  courses: ["title"],   // items 是单一数组（每组自带 name/list 三语），见下方专项校验
  competition: ["name", "detail"],
  pubList: ["kind"],
};

export function validate(data) {
  const errors = [];
  const warn = [];
  const E = (m) => errors.push(m);
  const W = (m) => warn.push(m);

  if (!data.meta?.schemaVersion) E("meta.schemaVersion 缺失");
  if (!data.profile?.name) E("profile.name 缺失");
  if (!data.sections) E("sections 缺失");
  if (!data.nodes || !data.order?.default) E("nodes 或 order.default 缺失");
  if (errors.length) return { errors, warn };

  // 1) 板块声明必须覆盖所有 sectionOf 可能返回的板块
  for (const sec of SECTIONS) {
    if (!data.sections[sec]) E(`sections 缺少板块声明: ${sec}`);
  }

  // 2) 每个节点：id 唯一（JSON 结构保证）、type 已知、level 合法
  const nodes = data.nodes;
  for (const [id, node] of Object.entries(nodes)) {
    if (!node.type) { E(`${id}: 缺少 type`); continue; }
    if (!(node.type in LANG_FIELDS)) { E(`${id}: 未知 type "${node.type}"`); continue; }
    if (node.level != null && ![1, 2, 3].includes(node.level)) E(`${id}: level 必须为 1/2/3，当前 ${node.level}`);
    let sec;
    try { sec = sectionOf(node); } catch { E(`${id}: 无法归属板块`); continue; }
    if (!data.sections[sec]) E(`${id}: 归属板块 ${sec} 未在 sections 中声明`);

    // 3) 多语言字段完整性
    for (const field of LANG_FIELDS[node.type]) {
      const v = node[field];
      if (v == null) { E(`${id}: 缺少必填语言字段 ${field}`); continue; }
      if (typeof v !== "object" || Array.isArray(v)) { E(`${id}.${field}: 应为 {zh,en,ru} 对象`); continue; }
      for (const lang of LANGS) {
        if (v[lang] == null) E(`${id}.${field}: 缺少语言 ${lang}`);
      }
    }
    // 语言对象：不允许出现未声明的语言键
    const checkLangKeys = (obj, path) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
      for (const k of Object.keys(obj)) {
        if (!LANGS.includes(k)) W(`${id}.${path}: 出现未知语言键 "${k}"`);
      }
    };
    for (const field of LANG_FIELDS[node.type]) checkLangKeys(node[field], field);

    // 4) 子条目（blocks / bullets / items）的结构与语言完整性
    const checkTexts = (arr, path) => {
      if (!Array.isArray(arr)) { E(`${id}.${path}: 应为数组`); return; }
      arr.forEach((b, i) => {
        if (b.level != null && ![1, 2, 3].includes(b.level)) E(`${id}.${path}[${i}]: level 非法`);
        if (!b.text) { E(`${id}.${path}[${i}]: 缺少 text`); return; }
        for (const lang of LANGS) if (b.text[lang] == null) E(`${id}.${path}[${i}].text: 缺少语言 ${lang}`);
      });
    };
    if (node.type === "job" || node.type === "research") {
      if (!Array.isArray(node.blocks) || !node.blocks.length) E(`${id}: blocks 不能为空`);
      (node.blocks ?? []).forEach((b, i) => {
        if (b.level != null && ![1, 2, 3].includes(b.level)) E(`${id}.blocks[${i}]: level 非法`);
        if (b.heading) {
          for (const lang of LANGS) if (b.heading[lang] == null) E(`${id}.blocks[${i}].heading: 缺少语言 ${lang}`);
        }
        if (!b.heading && !(b.bullets ?? []).length) E(`${id}.blocks[${i}]: 既无 heading 也无 bullets`);
        checkTexts(b.bullets ?? [], `blocks[${i}].bullets`);
      });
    }
    if (node.type === "pubList") checkTexts(node.items, "items");
    if (node.type === "skills") {
      node.groups?.forEach((g, gi) => {
        for (const lang of LANGS) if (g.area?.[lang] == null) E(`${id}.groups[${gi}].area: 缺少语言 ${lang}`);
        g.items?.forEach((it, ii) => {
          if (!it.level || it.level < 1 || it.level > 5) E(`${id}.groups[${gi}].items[${ii}]: level 需 1-5`);
          for (const lang of LANGS) if (it.name?.[lang] == null) E(`${id}.groups[${gi}].items[${ii}].name: 缺少语言 ${lang}`);
        });
      });
    }
    if (node.type === "courses") {
      // 单一数组结构：items = [{ name:{zh,en,ru}, list:{zh:[...],en:[...],ru:[...]} }, ...]
      // 总名与分名都必须三语齐全，否则某一语言的课程表会出现空标题或空列表。
      // （这层校验是必须的：早期结构是 items.{zh,en,ru} 三份副本，总名对象里
      //   混着三种语言、靠"哪份在前"决定语言，于是英文/俄文页面显示中文总名。）
      const groups = node.items;
      if (!Array.isArray(groups)) { E(`${id}.items: 必须是数组（单一结构），不能再按语言分副本`); continue; }
      if (!groups.length) E(`${id}.items: 分组为空`);
      groups.forEach((grp, gi) => {
        if (!grp.name) E(`${id}.items[${gi}]: 缺少总名 name`);
        else for (const l2 of LANGS) if (grp.name[l2] == null) E(`${id}.items[${gi}].name: 缺少语言 ${l2}`);
        if (!grp.list) E(`${id}.items[${gi}]: 缺少分名 list`);
        else for (const l2 of LANGS) {
          if (!Array.isArray(grp.list[l2])) E(`${id}.items[${gi}].list: 缺少语言数组 ${l2}`);
          else if (!grp.list[l2].length) E(`${id}.items[${gi}].list.${l2}: 分名为空`);
        }
      });
    }
  }

  // 5) order.default：引用存在、无重复、覆盖全部节点
  const seen = new Set();
  for (const id of data.order.default) {
    if (!nodes[id]) E(`order.default 引用了不存在的节点: ${id}`);
    if (seen.has(id)) E(`order.default 重复引用: ${id}`);
    seen.add(id);
  }
  for (const id of Object.keys(nodes)) {
    if (!seen.has(id)) E(`节点 ${id} 未出现在 order.default 中（会永远不显示）`);
  }

  // 6) 版本配置
  if (!data.variants || !Object.keys(data.variants).length) E("variants 缺失");
  for (const [key, v] of Object.entries(data.variants ?? {})) {
    if (!v.label?.zh || !v.label?.en) E(`variants.${key}.label 需要 zh 与 en`);
    if (!Array.isArray(v.langs) || !v.langs.length) E(`variants.${key}.langs 不能为空`);
    for (const l of v.langs ?? []) if (!LANGS.includes(l)) E(`variants.${key}.langs 含未知语言 ${l}`);
    for (const id of v.dropNodes ?? []) if (!nodes[id]) E(`variants.${key}.dropNodes 引用了不存在的节点: ${id}`);
    if (v.maxLevel != null && ![1, 2, 3].includes(v.maxLevel)) E(`variants.${key}.maxLevel 非法`);
    // 板块顺序必须合法
    for (const s of v.sectionOrder ?? []) {
      if (!SECTIONS.includes(s)) E(`variants.${key}.sectionOrder 含未知板块 ${s}`);
    }
    // 该版本每种语言至少要有一个可见节点
    for (const lang of v.langs ?? []) {
      const dropTags = new Set(v.dropTags ?? []);
      const dropNodes = new Set(v.dropNodes ?? []);
      const n = data.order.default.filter((id) => {
        if (dropNodes.has(id)) return false;
        const node = nodes[id];
        if ((node.tags ?? []).some((t) => dropTags.has(t))) return false;
        return (node.level ?? 1) <= (v.maxLevel ?? 3);
      });
      if (!n.length) E(`variants.${key} + ${lang}: 没有任何可见节点（配置过严）`);
    }
  }

  // 7) 旧口径防回流：只在内容里查（meta.syncWarning 本身就在描述这件事，跳过）
  const raw = JSON.stringify({ profile: data.profile, nodes: data.nodes });
  for (const bad of ["50%", "16 bit", "16bit", "16-bit"]) {
    if (raw.includes(bad)) W(`内容中出现可疑旧口径 "${bad}"，请确认是否为 8-12 bit 表述`);
  }

  return { errors, warn };
}

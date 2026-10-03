// 把 data/resume.master.json 里的"可编辑文本"导出成一份易读的 md（给人工修改）。
//
// 两条硬要求：
//   1) **往返无损** —— 导出→不动→导回，必须得到与原始数据完全相同的 JSON（见 import-text.mjs --assert）
//   2) **覆盖完整** —— 数据里每个"语言文本叶子"都必须出现在 md 里，否则人工改不到、会被静默丢掉
//
// 标记一律用**完全限定路径**（如 nodes.skills.groups[0].area），与 JSON 结构一一对应，
// 便于导入端用同一套路径解析，避免"相对路径 vs 绝对路径"这类错位。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "resume.master.json");
const OUT = join(ROOT, "文本编辑.md");

const LANGS = ["zh", "en", "ru"];
const LANG_NAME = { zh: "中文", en: "English", ru: "Русский" };

/** 路径数组 → 完全限定标记： a.b[0].c ；键名含点号时写成 a["b.c"].d
 *  （节点 id 形如 objective.main / job.huawei，必须用引号包住才不会与分隔点混淆） */
function pathStr(parts) {
  let s = "";
  for (const p of parts) {
    if (typeof p === "number") { s += `[${p}]`; continue; }
    if (p.includes(".") || p.includes('"')) s += `["${p.replace(/"/g, '\\"')}"]`;
    else s += s === "" ? p : "." + p;
  }
  return s;
}

const data = JSON.parse(readFileSync(DATA, "utf8"));
const L = [];
const w = (s = "") => L.push(s);

/** 输出若干"字段 × 语言"块。leaves: [{ label, values }]
 *  label 的语义与 values 对应：
 *    - values 是 {zh,en,ru} 对象 → label 指向该对象，标记为 `label · 语言`
 *    - values 是纯字符串        → label 已包含语言（如 nodes[...].items[0].zh），不再追加语言 */
function emit(leaves) {
  let any = false;
  for (const { label, values } of leaves) {
    if (typeof values === "string") {
      any = true;
      const laneName = LANG_NAME[label.slice(label.lastIndexOf(".") + 1)];
      w(`【${label}${laneName ? " · " + laneName : ""}】`);
      w(values === "" ? "（空）" : values);
      w();
      continue;
    }
    if (!values || typeof values !== "object") continue;
    for (const lang of LANGS) {
      if (values[lang] === undefined) continue;
      any = true;
      const v = String(values[lang]);
      w(`【${label} · ${LANG_NAME[lang]}】`);
      if (v.includes("\n")) {
        w("```text");
        w(v);
        w("```");
      } else if (v === "") {
        w("（空）");
      } else {
        w(v);
      }
      w();
    }
  }
  if (any) { w("---"); w(); }
}
const P = (parts) => pathStr(parts);

w("# 简历文本（可编辑）");
w();
w("> 改这个文件里的文字，然后告诉我，我导回数据并重新生成网站与 PDF。");
w(">");
w("> **改的时候注意**");
w("> 1. 只改 `【…】` 标记**下面**的内容。**不要动** `【…】` 标记行、`###`/`##` 标题、`---` 分隔线——它们是我定位的依据。");
w("> 2. 每个 `【…】` 下面就是对应语言的文本。多行文本包在 ```text 代码块 里；单行文本直接一行。");
w("> 3. 想清空某段文字：把那行改成 `（空）`。");
w("> 4. 三种语言各自独立，不改的保持原样即可。");
w("> 5. 标点保持全角/半角原样；改完不用管格式，我会重新构建并自检。");
w(">");
w("> 标记的含义：`profile.` = 页头信息，`sections.` = 板块标题，`nodes.<节点名>.` = 正文内容，`variants.` = 各版本名称。");
w();
w("---");
w();

/* 一、基本信息 */
w("## 一、基本信息");
w();
w("### 姓名与定位");
w();
emit([
  { label: P(["profile", "name"]), values: data.profile.name },
  { label: P(["profile", "title"]), values: data.profile.title },
  { label: P(["profile", "location"]), values: data.profile.location },
]);
w("### 页头联系方式（按此顺序显示）");
w();
data.profile.links.forEach((l, i) => {
  emit([{ label: P(["profile", "links", i, "label"]), values: l.label }]);
});

/* 二、板块标题 */
w("## 二、板块标题");
w();
for (const [k, sec] of Object.entries(data.sections)) {
  emit([{ label: P(["sections", k, "title"]), values: sec.title }]);
}

/* 三、正文 */
w("## 三、正文内容");
w();
for (const [id, node] of Object.entries(data.nodes)) {
  w(`## ${id}`);
  w();
  const simple = [];
  for (const f of ["title", "org", "date", "degree", "school", "major", "thesis", "advisor", "program", "scholarship", "name", "detail", "kind", "area", "pitch", "awards", "text"]) {
    if (node[f] && typeof node[f] === "object" && !Array.isArray(node[f])) {
      simple.push({ label: P(["nodes", id, f]), values: node[f] });
    }
  }
  // link.label 嵌在 link 对象里（link.href 是网址，不需要人工改，故只导出 label）
  if (node.link && node.link.label && typeof node.link.label === "object") {
    simple.push({ label: P(["nodes", id, "link", "label"]), values: node.link.label });
  }
  if (simple.length) { w("### 字段"); w(); emit(simple); }

  if (Array.isArray(node.targets)) {
    w("### 求职目标条目"); w();
    emit(node.targets.map((_, i) => ({ label: P(["nodes", id, "targets", i]), values: node.targets[i] })));
  }
  // 数字卡片（stats）：value 是固定值不导出，只导出说明文字
  if (Array.isArray(node.items) && node.items.length && node.items[0] && node.items[0].label) {
    w("### 数字卡片（左侧数字为固定值，只改右侧说明）"); w();
    emit(node.items.map((it, i) => ({ label: P(["nodes", id, "items", i, "label"]), values: it.label })));
  }
  if (Array.isArray(node.items) && node.items.length && node.items[0] && node.items[0].text) {
    w("### 条目"); w();
    emit(node.items.map((it, i) => ({ label: P(["nodes", id, "items", i, "text"]), values: it.text })));
  }
  if (node.items && !Array.isArray(node.items)) {
    w("### 列表项"); w();
    const leaves = [];
    for (const lang of LANGS) {
      const arr = node.items[lang];
      if (!Array.isArray(arr)) continue;
      arr.forEach((_, i) => leaves.push({ label: P(["nodes", id, "items", lang, i]), values: arr[i] }));
    }
    emit(leaves);
  }
  // 课程表：单一数组 items = [{name:{…}, list:{zh:[],en:[],ru:[]}}]。
  // 总名用 name（三语对象），分名逐条列出、每条一个独立标记（增删条目要靠改数据，这里只管改字）。
  // 早期版本漏了这个分支：课程名与课程列表全都不在 md 里，人工改不到（导入端会报"未覆盖"并拒绝写盘）。
  if (Array.isArray(node.items) && node.items.length && node.items[0] && node.items[0].list) {
    node.items.forEach((grp, gi) => {
      w(`### 课程分组 ${gi + 1}`);
      w();
      emit([{ label: P(["nodes", id, "items", gi, "name"]), values: grp.name }]);
      const leaves = [];
      for (const lang of LANGS) {
        const arr = grp.list?.[lang];
        if (!Array.isArray(arr)) continue;
        arr.forEach((_, i) => leaves.push({ label: P(["nodes", id, "items", gi, "list", lang, i]), values: arr[i] }));
      }
      emit(leaves);
    });
  }
  if (Array.isArray(node.blocks)) {
    node.blocks.forEach((b, bi) => {
      w(`### 工作块 ${bi + 1}`);
      w();
      if (b.heading) emit([{ label: P(["nodes", id, "blocks", bi, "heading"]), values: b.heading }]);
      if (Array.isArray(b.bullets) && b.bullets.length) {
        emit(b.bullets.map((x, xi) => ({ label: P(["nodes", id, "blocks", bi, "bullets", xi, "text"]), values: x.text })));
      }
    });
  }
  if (Array.isArray(node.groups)) {
    node.groups.forEach((g, gi) => {
      w(`### 技能分组 ${gi + 1}`);
      w();
      const leaves = [{ label: P(["nodes", id, "groups", gi, "area"]), values: g.area }];
      g.items.forEach((it, ii) => leaves.push({ label: P(["nodes", id, "groups", gi, "items", ii, "name"]), values: it.name }));
      g.items.forEach((it, ii) => { if (it.note) leaves.push({ label: P(["nodes", id, "groups", gi, "items", ii, "note"]), values: it.note }); });
      emit(leaves);
    });
  }
}

/* 四、版本名称 */
w("## 四、各版本名称");
w();
for (const [k, v] of Object.entries(data.variants)) {
  emit([{ label: P(["variants", k, "label"]), values: v.label }]);
}

/* 五、版本目标 */
const withT = Object.entries(data.variants).filter(([, v]) => v.targets);
if (withT.length) {
  w("## 五、各版本的目标（网页顶部提示用）");
  w();
  for (const [k, v] of withT) emit([{ label: P(["variants", k, "targets"]), values: v.targets }]);
}

writeFileSync(OUT, L.join("\n").replace(/\n{4,}/g, "\n\n\n") + "\n", "utf8");

/* 自检：统计导出覆盖的文本叶子数 */
let total = 0;
const walk = (o) => {
  if (typeof o === "string") return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (o && typeof o === "object") for (const v of Object.values(o)) walk(v);
};
const countLeaves = (o, path = []) => {
  if (typeof o === "string") {
    if (["zh", "en", "ru"].includes(path[path.length - 1])) total++;
    return;
  }
  if (Array.isArray(o)) { o.forEach((v, i) => countLeaves(v, [...path, i])); return; }
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) countLeaves(v, [...path, k]);
};
countLeaves({ profile: data.profile, sections: data.sections, nodes: data.nodes, variants: data.variants });
console.log(`✓ 已导出 文本编辑.md（${(readFileSync(OUT).length / 1024).toFixed(1)} KB）`);
console.log(`  可编辑文本叶子共 ${total} 个`);

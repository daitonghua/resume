// 把人工修改过的 文本编辑.md 导回 data/resume.master.json。
//
// 用法：
//   node tools/import-text.mjs --dry      只比对并打印差异，不写盘
//   node tools/import-text.mjs            导入并写盘
//   node tools/import-text.mjs --assert   自证往返无损（导出→导回，JSON 必须逐字节相同）
//
// 为什么必须有 --assert 和覆盖率检查：
//   这个工具的价值全在"改 md 能准确落到数据上"。若导出/导入不对称（漏字段、路径错位、
//   首尾空格差异），人工改的文案就会静默丢失或串位——那比没有工具更糟。
//   所以：(a) 数据里每个语言文本叶子都必须被 md 覆盖，否则拒绝写盘；
//         (b) --assert 用逐字节比对守住往返一致性。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "resume.master.json");
const MD = join(ROOT, "文本编辑.md");
const LANG_NAME = { zh: "中文", en: "English", ru: "Русский" };
const NAME_LANG = { 中文: "zh", English: "en", Русский: "ru" };

/* ---------------- 解析 md ---------------- */
/** 返回 [{ label, lang, value, line }] */
function parseMd(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^【(.+?) · (中文|English|Русский)】\s*$/.exec(lines[i]);
    if (!m) continue;
    const label = m[1].trim();
    const lang = NAME_LANG[m[2]];
    const line = i + 1;
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
    let value;
    if (lines[i]?.trim() === "```text") {
      i++;
      const buf = [];
      while (i < lines.length && lines[i].trim() !== "```") { buf.push(lines[i]); i++; }
      value = buf.join("\n");
    } else if (lines[i]?.trim() === "（空）" || lines[i]?.trim() === "（空——留空表示不显示）") {
      value = "";
    } else {
      value = (lines[i] ?? "").trim();
    }
    out.push({ label, lang, value, line });
  }
  return out;
}

/* ---------------- 路径解析与写回 ---------------- */
/** 解析完全限定路径。支持两种写法：
 *    a.b[0].c            —— 普通键与数组下标
 *    a["b.c"].d          —— 键名本身含点号（本项目节点 id 形如 objective.main / job.huawei）
 *  为什么必须支持引号写法：节点 id 自带点号，扁平点号路径无法区分
 *  "nodes 下的 objective.main 节点" 与 "nodes.objective 下的 main"（曾因此 279 个标记定位失败）。 */
function parsePath(label) {
  const parts = [];
  const re = /([^\[\]."]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  let m;
  while ((m = re.exec(label))) {
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(Number(m[2]));
    else parts.push(m[3].replace(/\\(.)/g, "$1"));
  }
  return parts;
}
function setByPath(root, parts, value) {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) throw new Error(`路径中断于 ${parts.slice(0, i + 1).join(".")}`);
    cur = cur[parts[i]];
  }
  if (cur == null) throw new Error(`路径中断于 ${parts.slice(0, -1).join(".")}`);
  const last = parts[parts.length - 1];
  if (!(last in cur)) throw new Error(`末段键不存在: ${parts.join(".")}`);
  const old = cur[last];
  cur[last] = value;
  return old;
}

/** 收集数据里全部"语言文本叶子"的完全限定路径（与 md 标记同构） */
function collectLeafLabels(obj, path = [], out = new Set()) {
  if (typeof obj === "string") {
    const lang = path[path.length - 1];
    if (["zh", "en", "ru"].includes(lang)) {
      let s = "";
      for (const p of path.slice(0, -1)) {
        if (typeof p === "number") s += `[${p}]`;
        else if (p.includes(".") || p.includes('"')) s += `["${p.replace(/"/g, '\\"')}"]`;
        else s += s === "" ? p : "." + p;
      }
      out.add(s);
    } else {
      out.add("__SKIP__" + path.join("."));
    }
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach((v, i) => collectLeafLabels(v, [...path, i], out)); return out; }
  if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) collectLeafLabels(v, [...path, k], out);
  return out;
}

/* ---------------- 主流程 ---------------- */
const mode = process.argv.includes("--assert") ? "assert"
  : process.argv.includes("--dry") ? "dry" : "import";

if (mode === "assert") {
  const before = readFileSync(DATA, "utf8");
  // stdio 必须是 "inherit"：本机沙箱下子进程无法打开命名管道，
  // execFileSync 用管道（默认 "pipe" / "ignore"）会直接 EPERM 抛错，
  // 看起来像"往返不一致"，实际是环境限制——排查过一次才知道。
  execFileSync(process.execPath, [join(ROOT, "tools", "export-text.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(ROOT, "tools", "import-text.mjs")], { stdio: "inherit" });
  const after = readFileSync(DATA, "utf8");
  if (before === after) {
    console.log("✓ 往返无损：导出→导回后 JSON 与原始数据逐字节相同");
    process.exit(0);
  }
  console.error("✗ 往返不一致：导出/导入不对称，不能用于改文案。");
  const a = before.split("\n"), b = after.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  首个差异 第 ${i + 1} 行:\n    原始: ${JSON.stringify(a[i])}\n    导回: ${JSON.stringify(b[i])}`);
      break;
    }
  }
  process.exit(1);
}

if (!existsSync(MD)) { console.error(`✗ 找不到 文本编辑.md，请先运行 node tools/export-text.mjs`); process.exit(1); }

const blocks = parseMd(readFileSync(MD, "utf8"));
const data = JSON.parse(readFileSync(DATA, "utf8"));

const leaves = new Set();
for (const [k, v] of Object.entries({ profile: data.profile, sections: data.sections, nodes: data.nodes, variants: data.variants })) {
  collectLeafLabels(v, [k], leaves);
}
const realLeaves = new Set([...leaves].filter((l) => !l.startsWith("__SKIP__")));

const changes = [], notFound = [];
const applied = new Set();

for (const { label, lang, value, line } of blocks) {
  const parts = parsePath(label);
  if (!parts.length) { notFound.push({ label, line, why: "标记无法解析" }); continue; }

  // 标记末段已是语言键、且该处存的是字符串时（如 nodes[...].items[0].zh，
  // courses 节点的 items 是 {zh:[...], en:[...]}，元素是纯字符串），直接写该位置，
  // 不能再追加一层语言，否则路径变成 ....zh.zh（曾因此 75 个标记定位失败）。
  const endsWithLang = ["zh", "en", "ru"].includes(parts[parts.length - 1]);
  const targetParts = endsWithLang ? parts : [...parts, lang];

  let old;
  try { old = setByPath(data, targetParts, value); }
  catch (e) { notFound.push({ label, line, why: e.message }); continue; }
  applied.add(label);
  if (old !== value) changes.push({ label, lang, old, value, line });
}

const uncovered = [...realLeaves].filter((l) => !applied.has(l));

console.log(`md 解析出 ${blocks.length} 个文本块（覆盖 ${applied.size} 个数据字段）`);
console.log(`本次改动 ${changes.length} 处`);
if (notFound.length) {
  console.log(`✗ md 中有 ${notFound.length} 个标记无法定位：`);
  for (const n of notFound.slice(0, 8)) console.log(`   第 ${n.line} 行 "${n.label}" ← ${n.why}`);
}
if (uncovered.length) {
  console.log(`✗ 数据中有 ${uncovered.length} 个文本字段未被 md 覆盖（导出漏字段）：`);
  for (const u of uncovered.slice(0, 8)) console.log(`   ${u}`);
}

if (changes.length && mode !== "assert") {
  console.log("\n改动明细:");
  const one = (s) => String(s).replace(/\s+/g, " ");
  for (const c of changes) {
    console.log(`\n  [${LANG_NAME[c.lang]}] ${c.label}`);
    console.log(`    旧: ${one(c.old)}`);
    console.log(`    新: ${one(c.value)}`);
  }
}

if (mode === "dry") { console.log("\n（--dry：未写盘）"); process.exit(0); }

if (notFound.length || uncovered.length) {
  console.error("\n✗ 存在无法定位或未覆盖的字段；为避免静默丢文案，已中止写盘。");
  process.exit(1);
}

writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`\n✓ 已写回 data/resume.master.json`);
console.log("  下一步: pnpm all && pnpm check && pnpm verify");

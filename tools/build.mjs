// 构建入口：校验 → 生成 index.html（动态全量页）+ v/*.html（静态裁剪版）+ manifest.json
// 用法：
//   node tools/build.mjs            构建
//   node tools/build.mjs --check    只校验并检查磁盘产物是否与数据一致（不写盘）
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";
import { buildPayload, renderDynamic, renderStatic } from "../src/web.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data", "resume.master.json");
const CHECK = process.argv.includes("--check");

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error("\n✗ " + msg); process.exit(1); };

/* ---------- 1. 读数据 ---------- */
if (!existsSync(DATA_FILE)) fail(`找不到数据文件 ${DATA_FILE}`);
const rawText = readFileSync(DATA_FILE, "utf8");
let data;
try { data = JSON.parse(rawText); } catch (e) { fail(`JSON 解析失败: ${e.message}`); }

/* ---------- 2. 校验 ---------- */
const { errors, warn } = validate(data);
if (warn.length) { log("⚠ 警告:"); warn.forEach((w) => log("  - " + w)); }
if (errors.length) {
  console.error("\n✗ 数据校验未通过：");
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}
log(`✓ 数据校验通过（${Object.keys(data.nodes).length} 个节点，${Object.keys(data.variants).length} 个版本）`);

/* ---------- 3. 内容哈希（写进产物，用于判断"改了数据忘了重建"） ---------- */
const contentHash = createHash("sha256").update(rawText).digest("hex").slice(0, 12);

/* ---------- 4. 计算产出清单 ---------- */
const variantKeys = Object.keys(data.variants);
const payload = buildPayload(data);

const outputs = [];
// 4a. 动态主页
outputs.push({
  path: "index.html",
  kind: "dynamic",
  html: renderDynamic(data, payload, { contentHash, variants: variantKeys }),
});
// 4b. 静态版本页（每个版本 × 每个语言）
const statics = [];
for (const key of variantKeys) {
  for (const lang of data.variants[key].langs) {
    // 路径统一用正斜杠：这是给 URL 与浏览器用的，Windows 的反斜杠会拼出坏链接
    const rel = `v/${key}.${lang}.html`;
    statics.push({ variant: key, lang, rel });
    outputs.push({
      path: rel,
      kind: "static",
      html: renderStatic(data, key, lang, { contentHash }),
    });
  }
}
// 4c. manifest
const manifest = {
  contentHash,
  updated: data.meta.updated,
  generatedFrom: "data/resume.master.json",
  pdf: variantKeys.flatMap((k) => data.variants[k].langs.map((l) => `dist/resume-${k}.${l}.pdf`)),
  pages: statics.map((s) => ({ variant: s.variant, lang: s.lang, path: s.rel })),
};
outputs.push({
  path: "build-manifest.json",
  kind: "manifest",
  html: JSON.stringify(manifest, null, 2) + "\n",
});

/* ---------- 5. --check：只比对，不写盘 ---------- */
if (CHECK) {
  let drift = 0;
  for (const o of outputs) {
    const abs = join(ROOT, o.path);
    if (!existsSync(abs)) { console.error(`✗ 缺少产物: ${o.path}`); drift++; continue; }
    const onDisk = readFileSync(abs, "utf8");
    if (onDisk !== o.html) { console.error(`✗ 产物与数据不一致（需重新构建）: ${o.path}`); drift++; }
  }
  // 反向检查：磁盘上是否有已不再产出的静态页
  const wantStatic = new Set(statics.map((s) => s.rel.replace(/\\/g, "/")));
  const vDir = join(ROOT, "v");
  if (existsSync(vDir)) {
    for (const f of readdirSync(vDir)) {
      const rel = `v/${f}`;
      if (f.endsWith(".html") && !wantStatic.has(rel)) {
        console.error(`✗ 存在陈旧产物（应删除）: ${rel}`); drift++;
      }
    }
  }
  if (drift) { console.error(`\n✗ 产物检查未通过：${drift} 处偏差`); process.exit(1); }
  log(`✓ 产物检查通过：${outputs.length} 个文件均与数据一致（contentHash ${contentHash}）`);
  process.exit(0);
}

/* ---------- 6. 写盘 ---------- */
// 清掉不再需要的静态页，避免旧版本页面残留在线上
const vDir = join(ROOT, "v");
if (existsSync(vDir)) {
  const want = new Set(statics.map((s) => `${s.variant}.${s.lang}.html`));
  for (const f of readdirSync(vDir)) {
    if (f.endsWith(".html") && !want.has(f)) {
      rmSync(join(vDir, f));
      log(`  · 移除陈旧页面 v/${f}`);
    }
  }
}
mkdirSync(vDir, { recursive: true });
for (const o of outputs) {
  const abs = join(ROOT, o.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, o.html, "utf8");
  log(`  · ${o.path.padEnd(26)} ${(Buffer.byteLength(o.html) / 1024).toFixed(1)} KB`);
}

log(`\n✓ 构建完成（contentHash ${contentHash}）`);
log(`  动态主页: index.html —— 全量信息，可切换 ${variantKeys.length} 个版本 × 语言`);
log(`  静态页面: ${statics.length} 个（${variantKeys.length} 版本）`);
log(`  下一步:   node tools/build-pdf.mjs   → 生成 dist/*.pdf`);

// 生成 PDF：每个版本 × 每种语言一份，输出到 dist/
// 用法：
//   node tools/build-pdf.mjs                 全部版本（6 版本 / 14 份）
//   node tools/build-pdf.mjs ai dpd          只生成指定版本
//   node tools/build-pdf.mjs --lang zh       只生成指定语言
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { layout, resolveFonts, S } from "../src/pdf.mjs";
import { makeSelectNodes } from "../src/render.mjs";
import { validate } from "./validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data", "resume.master.json");
const OUT_DIR = join(ROOT, "dist");

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const report = argv.includes("--report");        // 输出每个节点的起止页（用来核对分页是否切断条目）
const langFilter = (() => {
  const i = argv.indexOf("--lang");
  return i >= 0 ? argv[i + 1] : null;
})();
const variantFilter = argv.filter((a) => !a.startsWith("--") && a !== langFilter);

/* ---------- 数据 ---------- */
const rawText = readFileSync(DATA_FILE, "utf8");
const data = JSON.parse(rawText);
const { errors } = validate(data);
if (errors.length) {
  console.error("✗ 数据校验未通过，先修数据：");
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}
const selectNodes = makeSelectNodes(data);

/**
 * PDF 元数据一律用 ASCII。
 *
 * 原因：pdfkit 把 /Title 等非 ASCII 值以 UTF-16BE 字节塞进 PDF 字面串，某些字符的字节
 * 会与字面串的定界/转义冲突，元数据被静默写坏（不报错）。
 * 实测会坏的字符包括 ( ) （ ） ｜ ， 「 」 《 等，但**按字节或字符都无法可靠预判**：
 *   - '｜' = FF 5C 坏（含 0x5C）
 *   - '用' = 75 28 却并不坏，而 '通' = 90 1A 安全
 *   - 我按"含 0x28/0x29/0x5C/0x7C"推断时，同时误判了 '用'、漏掉了 '（'
 * 与其维护一个不可靠的黑名单，不如把元数据限制在 ASCII（实测 ASCII 与西里尔往返完全一致）。
 * 元数据只影响阅读器标题栏与归档归类，正文内容不受任何影响。
 */
const asciiMeta = (s, fallback = "Resume") => {
  const out = String(s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  return out || fallback;
};


/* ---------- 字体 ---------- */
const { fonts, missing } = resolveFonts();
if (missing.length) {
  console.error(`✗ 缺少字体: ${missing.join(", ")}`);
  console.error("  需要 Arial(arial.ttf/arialbd.ttf/ariali.ttf) 与中文字体(Deng.ttf 或 simhei.ttf)。");
  process.exit(1);
}
console.log("字体路由：");
for (const [k, p] of Object.entries(fonts)) console.log(`  ${k.padEnd(10)} → ${p}`);

/* ---------- 生成 ---------- */
mkdirSync(OUT_DIR, { recursive: true });

/** 数据内容哈希：写进 dist/pdf-manifest.json，供校验"PDF 是否与当前数据同步"。
 *  没有这个登记，改了数据却忘了跑 pnpm pdf 时不会有任何提示——
 *  dist 里会静默留着上一轮的旧 PDF（本项目踩过：连续多轮"验证"的都是陈旧产物）。 */
const dataHash = createHash("sha256").update(rawText).digest("hex").slice(0, 12);

const jobs = [];
for (const [key, variant] of Object.entries(data.variants)) {
  if (variantFilter.length && !variantFilter.includes(key)) continue;
  for (const lang of variant.langs) {
    if (langFilter && lang !== langFilter) continue;
    jobs.push({ key, lang });
  }
}
if (!jobs.length) { console.error("✗ 没有匹配的版本/语言组合"); process.exit(1); }

console.log(`\n生成 ${jobs.length} 份 PDF …`);
const results = [];
const failures = [];

for (const { key, lang } of jobs) {
  const file = join(OUT_DIR, `resume-${key}.${lang}.pdf`);
  const doc = new PDFDocument({
    ...S.page,
    autoFirstPage: true,
    bufferPages: true,
    info: {
      // 元数据统一用 ASCII 标识（见 asciiMeta 注释）：中文名转成拼音形式的英文，避免 pdfkit 写坏
      Title: asciiMeta(`${"Dai Tonghua"} - ${data.variants[key].label.en ?? key}`, `${key} - resume`),
      Author: asciiMeta("Dai Tonghua", "Dai Tonghua"),
      Subject: asciiMeta("Algorithm Engineer - Quantization / DPD / Wireless Sensing", "Algorithm Engineer"),
      Keywords: "resume, quantization, DPD, wireless sensing, algorithm engineer",
      Creator: "resume build-pdf.mjs",
    },
  });

  // 注册字体（key 与 pdf.mjs 的字体路由 key 一致）
  for (const [k, p] of Object.entries(fonts)) doc.registerFont(k, p);

  const stream = createWriteStream(file);
  const done = new Promise((res, rej) => {
    stream.on("finish", res); stream.on("error", rej);
  });
  doc.pipe(stream);

  const trace = [];
  let totalPages = 0;
  let range = null;
  try {
    layout(doc, data, key, lang, selectNodes, report ? (info) => trace.push(info) : undefined);
    // 页数与几何信息必须在 end() 之前取；end() 之后缓冲区失效、doc.page 也会失效
    totalPages = doc.bufferedPageRange().count;
    if (report) {
      const M = doc.page.margins;
      const pageH = doc.page.height - M.top - M.bottom;
      const top = M.top;
      console.log(`\n  ── ${key}/${lang}（共 ${totalPages} 页，单页可用 ${Math.round(pageH)}pt）`);
      for (const t of trace) {
        // pagesBefore = 节点开始渲染时已有的页数，而 bufferedPageRange().count 在首页就是 1，
        // 所以它本身就是 1 基页号（已在多页文档上核对过）。
        const moved = t.pagesAfter > t.pagesBefore;
        const h = moved ? (pageH - (t.y0 - top)) + (t.y1 - top) : (t.y1 - t.y0);
        const over = h > pageH ? "  ⚠ 单条目超过一页" : "";
        console.log(`     p${t.pagesBefore}${moved ? `→p${t.pagesAfter}` : "   "}  ${t.id.padEnd(22)} ${t.type.padEnd(11)} 占高 ${String(Math.round(h)).padStart(4)}pt${over}`);
      }
    }
  } catch (e) {
    // 关键：这里必须让整个构建失败退出，不能只是打印一行然后 continue。
    // 曾经因为只打印不退出，排版错误被淹没在输出里，导致连续多轮"构建成功"
    // 其实一份 PDF 都没重写，磁盘上一直是旧文件（我据此做了好几轮基于陈旧产物的分析）。
    console.error(`✗ ${key}/${lang} 排版失败: ${e.message}`);
    console.error(`  ${String(e.stack).split("\n")[1]?.trim() ?? ""}`);
    try { doc.end(); } catch {}
    failures.push({ key, lang, error: e.message });
    continue;
  }
  doc.end();
  await done;

  const size = statSync(file).size;
  results.push({ key, lang, file: `dist/resume-${key}.${lang}.pdf`, size });
  console.log(`  · resume-${(key + "." + lang).padEnd(12)} ${(size / 1024).toFixed(1)} KB`);
}

console.log(`\n✓ 完成 ${results.length} 份 PDF → dist/`);
console.log("  校验: pnpm verify   （核对页数、字体嵌入、文本可提取性）");

if (failures.length) {
  console.error(`\n✗ 有 ${failures.length} 份排版失败：`);
  for (const f of failures) console.error(`  - ${f.key}/${f.lang}: ${f.error}`);
  process.exit(1);
}

// 登记本次生成的数据哈希：pnpm verify 会据此判断 dist 里的 PDF 是否已过期。
// 只在全部成功时写，避免用"生成了一半"的状态覆盖登记。
writeFileSync(join(OUT_DIR, "pdf-manifest.json"), JSON.stringify({
  dataHash,
  generatedAt: new Date().toISOString(),
  count: results.length,
  files: results.map((r) => ({ file: r.file, size: r.size })),
}, null, 2) + "\n", "utf8");
console.log(`  已登记数据哈希: ${dataHash}（dist/pdf-manifest.json）`);

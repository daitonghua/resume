// 汉字可复制性校验：PDF 的 ToUnicode 是否为"渲染器实际绘制的每个汉字"声明了码点。
//
// 权威来源说明（这是本文件存在的理由）：
//   期望值**不能**从数据结构里推测"哪些字段会被渲染"——那样会把 note 等不参与渲染的字段
//   算进来（本项目因此误报过 19 个汉字缺失）。正确做法是让布局层在绘制时报告真实文本：
//   src/pdf.mjs 的 drawLines() 会把每个 run 交给 doc.__onText，本脚本据此收集。
//
// 这条守卫要抓的缺陷（真实发生过）：
//   PICK() 里误写 isCJK(key)（对 "cjk" 字符串恒为 false）→ 所有汉字被交给 Arial
//   → PDF 能打开、版式正常，但 ToUnicode 只有 52 个汉字（应 300+），中文完全不可复制。
import PDFDocument from "pdfkit";
import { createWriteStream, readFileSync, unlinkSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFonts, S, layout, CJK_RE } from "../src/pdf.mjs";
import { makeSelectNodes } from "../src/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));
const selectNodes = makeSelectNodes(data);
const fonts = resolveFonts().fonts;

/** 只做最简的 4 位十六进制 token 扫描：不解析 CMap 语法结构（那些结构我连续写错过 4 次） */
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
      // 必须同时覆盖三种区块，否则会把全角标点误判为"缺失"：
      //   U+4E00–U+9FFF 汉字
      //   U+3000–U+303F CJK 标点（、。「」【】等）
      //   U+FF00–U+FFEF 全角形式（：（）；，等）
      if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) {
        found.add(String.fromCharCode(cp));
      }
    }
  }
  return found;
}

let fail = 0;
const rows = [];
const probe = join(ROOT, "dist", "_copytest.pdf");

for (const [key, v] of Object.entries(data.variants)) {
  for (const lang of v.langs) {
    if (lang !== "zh") { rows.push([`${key}/${lang}`, "·", "跳过（非中文）"]); continue; }

    const drawn = new Set();
    const doc = new PDFDocument({ ...S.page, bufferPages: true });
    doc.pipe(createWriteStream(probe));
    for (const [k, p] of Object.entries(fonts)) doc.registerFont(k, p);
    doc.__onText = (t) => { for (const c of String(t)) if (CJK_RE.test(c)) drawn.add(c); };
    layout(doc, data, key, lang, selectNodes);
    doc.end();
    await new Promise((r) => setTimeout(r, 150));

    // 用真实产物核对（而不是探针文件），保证校验的就是交付物
    const real = join(ROOT, "dist", `resume-${key}.${lang}.pdf`);
    const declared = declaredCjk(readFileSync(real));
    const missing = [...drawn].filter((c) => !declared.has(c));

    const ok = missing.length === 0;
    if (!ok) fail++;
    rows.push([`${key}/${lang}`, `${ok ? "✓" : "✗"}`,
      ok ? `绘制 ${drawn.size} 个汉字，全部可复制` : `绘制 ${drawn.size} 个，缺 ${missing.length} 个: ${missing.slice(0, 24).join("")}`]);
  }
}

try { unlinkSync(probe); } catch {}

const w = Math.max(...rows.map((r) => r[0].length));
console.log("汉字可复制性（ToUnicode 是否覆盖渲染器实际绘制的每个汉字）\n" + "─".repeat(w + 66));
for (const [k, mark, msg] of rows) console.log(`${k.padEnd(w)}  ${mark}  ${msg}`);
console.log("─".repeat(w + 66));
console.log(fail ? `✗ ${fail} 个中文版本存在不可复制的汉字` : "✓ 所有中文版本的汉字都可被合规阅读器复制");
process.exit(fail ? 1 : 0);

// 元数据往返验证：确认写进 PDF 的 /Title /Author 与实际设置一致。
// pdfkit 会把非 ASCII 值按 UTF-16BE 塞进 PDF 字面串，部分字符会静默写坏，
// 因此元数据统一用 ASCII（见 tools/build-pdf.mjs 的 asciiMeta），本脚本负责守住这条底线。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "dist");

function readInfoEntry(raw, key) {
  const objBody = (n) => new RegExp(`(?:^|[\\s>])${n}\\s+0\\s+obj\\s*([\\s\\S]*?)\\s*endobj`).exec(raw)?.[1] ?? null;
  const ref = /\/Info\s+(\d+)\s+\d+\s+R/.exec(raw);
  if (!ref) return null;
  const dict = objBody(+ref[1]);
  const r = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  if (!r) return null;
  const body = objBody(+r[1]);
  if (body == null) return null;
  const b = Buffer.from(body.slice(body.indexOf("(") + 1, body.lastIndexOf(")")), "latin1");
  if (b[0] === 0xfe && b[1] === 0xff) {
    const d = b.subarray(2);
    const e = Buffer.alloc(d.length - (d.length % 2));
    for (let i = 0; i + 1 < d.length; i += 2) { e[i] = d[i + 1]; e[i + 1] = d[i]; }
    return e.toString("utf16le");
  }
  // 解 PDF 字面串转义（\( \) \\ 是正规写法，不是异常）；同时把非 ASCII 字节以 U+FFFD 标出，
  // 便于调用方判断"值里真的混进了非 ASCII"
  return b.toString("latin1").replace(/\\([()\\])/g, "$1");
}

let fail = 0;
const files = readdirSync(DIR).filter((f) => f.endsWith(".pdf")).sort();
console.log("PDF 元数据往返验证\n" + "─".repeat(76));
for (const f of files) {
  const raw = readFileSync(join(DIR, f)).toString("latin1");
  const title = readInfoEntry(raw, "Title");
  const author = readInfoEntry(raw, "Author");
  const problems = [];
  if (!title) problems.push("Title 缺失");
  if (!author) problems.push("Author 缺失");
  // 非 ASCII 字符留在元数据里就是写坏的风险信号
  for (const [k, v] of [["Title", title], ["Author", author]]) {
    if (v && /[^\x20-\x7E]/.test(v)) problems.push(`${k} 含非 ASCII: ${JSON.stringify(v)}`);
  }
  const ok = problems.length === 0;
  if (!ok) fail++;
  console.log(`${f.padEnd(28)} ${ok ? "✓" : "✗ " + problems.join("; ")}  Title="${title ?? ""}" Author="${author ?? ""}"`);
}
console.log("─".repeat(76));
console.log(fail ? `✗ ${fail} 份元数据有问题` : `✓ ${files.length} 份元数据都是干净的 ASCII`);
process.exit(fail ? 1 : 0);

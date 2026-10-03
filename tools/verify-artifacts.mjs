// 产物完整性检查：扫描所有 HTML/JSON 产物里出现的引用，确认它们都能落地。
//
// 检查项：
//   1) HTML 里每个 href/src（本地相对路径）在磁盘上存在
//   2) 外链是合法 URL（不校验可达性——沙箱网络不可靠）
//   3) 产物无残留占位符/未替换标记（如 undefined、[object Object]、{{...}}）
//   4) 每份 PDF 在 build-manifest.json 里被登记，反之亦然
//   5) 静态页的 lang 属性与文件名语言一致
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let problems = 0;
const report = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) problems++; };

/** 去掉 <script>/<style> 内容：脚本里的代码片段（如模板字符串里的 href）不是真的要取的资源，
 *  直接全文件扫 href 会产生假报错（曾把 "+esc(l.href)+" 当成坏链）。 */
const stripCode = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "");

/** 解析 PDF info 字典值。
 *  两级间接：trailer 里 `/Info 12 0 R` → 对象 12 是 info 字典 → 其值又是 `/Title 16 0 R` → 对象 16 才是字符串。
 *  值可能是 (literal) 或 <hex>（中文/西里尔走 hex）。只解一层会误判"元数据缺失"。 */
function pdfInfo(raw) {
  const objBody = (n) => {
    const re = new RegExp(`(?:^|[\\s>])${n}\\s+0\\s+obj\\s*([\\s\\S]*?)\\s*endobj`);
    return re.exec(raw)?.[1] ?? null;
  };
  const infoRef = /\/Info\s+(\d+)\s+\d+\s+R/.exec(raw);
  let dict = infoRef ? objBody(+infoRef[1]) : null;
  if (!dict) dict = /\/Info\s*<<([\s\S]*?)>>/.exec(raw)?.[1] ?? "";

  const decodeValue = (body) => {
    if (body == null) return null;
    // 用首末括号定界，而不是写"不含右括号"的正则：
    // 非 ASCII 的 UTF-16BE 字节里会出现 0x29（即 ')' 的一半），正则会把值截断/匹配失败
    // （俄文标题就因此被判成"元数据缺失"）。
    const open = body.indexOf("(");
    if (open >= 0) {
      const close = body.lastIndexOf(")");
      if (close > open) return body.slice(open + 1, close);
    }
    const hex = /^\s*<([0-9a-fA-F]+)>/.exec(body);
    if (!hex) return null;
    const bytes = [];
    for (let i = 0; i + 1 < hex[1].length; i += 2) bytes.push(parseInt(hex[1].slice(i, i + 2), 16));
    return Buffer.from(bytes).toString("latin1");
  };

  /** PDF 字面串里的非 ASCII 以 UTF-16BE 原始字节存放（每个字节占一个 char），
   *  必须按 latin1 取回字节再交换成 UTF-16LE 解码；直接用 charCodeAt 组对会得到乱码，
   *  从而把"元数据正常"误判为"损坏/缺失"。 */
  const fixUtf16 = (s) => {
    if (s == null) return null;
    const b = Buffer.from(s, "latin1");
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return swapUtf16(b.subarray(2));
    if (b.length >= 4 && b.filter((x) => x === 0).length > b.length / 3) return swapUtf16(b);
    return s;
  };
  const swapUtf16 = (b) => {
    const even = Buffer.alloc(b.length - (b.length % 2));
    for (let i = 0; i + 1 < b.length; i += 2) { even[i] = b[i + 1]; even[i + 1] = b[i]; }
    return even.toString("utf16le");
  };
  const get = (key) => {
    // 1) 直接字符串值
    const direct = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^)\\\\"])*\\)|<[0-9a-fA-F]+>)`).exec(dict);
    if (direct) return fixUtf16(decodeValue(direct[1]));
    // 2) 间接引用
    const ref = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
    if (ref) return fixUtf16(decodeValue(objBody(+ref[1])));
    return null;
  };
  return { title: get("Title"), author: get("Author"), subject: get("Subject"), hasInfo: !!dict };
}

/* ---------- 收集产物 ---------- */
const htmlFiles = ["index.html"];
const vDir = join(ROOT, "v");
if (existsSync(vDir)) for (const f of readdirSync(vDir).filter((x) => x.endsWith(".html"))) htmlFiles.push(`v/${f}`);

const manifest = JSON.parse(readFileSync(join(ROOT, "build-manifest.json"), "utf8"));

/* ---------- 1 & 2. 引用可达性 ---------- */
console.log("\n引用可达性");
const localRefs = new Set();
const externalRefs = new Set();
for (const rel of htmlFiles) {
  const html = stripCode(readFileSync(join(ROOT, rel), "utf8"));
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:") || url.startsWith("tel:")) {
      externalRefs.add(url);
    } else if (!url.startsWith("#") && !url.startsWith("data:")) {
      localRefs.add(url);
    }
  }
}
for (const ref of [...localRefs].sort()) {
  const abs = join(ROOT, normalize(ref));
  report(existsSync(abs), `${ref}${existsSync(abs) ? ` (${(statSync(abs).size / 1024).toFixed(1)} KB)` : " ← 不存在"}`);
}
console.log(`  · 外链 ${externalRefs.size} 个（不校验可达性）：${[...externalRefs].slice(0, 3).join(", ")}${externalRefs.size > 3 ? " …" : ""}`);
for (const u of externalRefs) {
  const ok = /^(https?:\/\/[\w.-]+\.[a-z]{2,}([/?#].*)?|mailto:[^@\s]+@[^@\s]+|tel:\+?[\d-]+)$/i.test(u);
  if (!ok) report(false, `外链格式可疑: ${u}`);
}

/* ---------- 3. 未替换标记 ---------- */
console.log("\n产物无残留标记");
let markerHits = 0;
for (const rel of [...htmlFiles, "build-manifest.json"]) {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  // 只看渲染出来的正文（去掉 script/style），脚本里出现这些词是正常的
  const t = rel.endsWith(".json") ? raw : stripCode(raw);
  for (const bad of ["undefined", "[object Object]", "NaN"]) {
    if (t.includes(bad)) { report(false, `${rel} 正文含 "${bad}"`); markerHits++; }
  }
}
if (!markerHits) report(true, "正文未出现 undefined / [object Object] / NaN");

/* ---------- 4. PDF 与 manifest 双向一致 ---------- */
console.log("\nPDF 与 manifest 双向一致");
const distDir = join(ROOT, "dist");
const distPdfs = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith(".pdf")).sort() : [];
const listed = [...manifest.pdf].map((p) => p.replace(/^dist\//, "")).sort();
const missingOnDisk = listed.filter((p) => !distPdfs.includes(p));
const notListed = distPdfs.filter((p) => !listed.includes(p));
report(missingOnDisk.length === 0, `manifest 登记的 PDF 都存在${missingOnDisk.length ? "：缺 " + missingOnDisk.join(", ") : `（${listed.length} 份）`}`);
report(notListed.length === 0, `dist 里没有未登记的 PDF${notListed.length ? "：多出 " + notListed.join(", ") : ""}`);

/* ---------- 5. 静态页语言属性一致 ---------- */
console.log("\n静态页语言属性");
for (const p of manifest.pages) {
  const html = readFileSync(join(ROOT, p.path), "utf8");
  const lang = /<html lang="([^"]+)"/.exec(html)?.[1];
  const expect = p.lang === "zh" ? "zh-CN" : p.lang;
  report(lang === expect, `${p.path} lang="${lang}"（应 ${expect}）`);
}

/* ---------- 6. PDF 元数据 ---------- */
console.log("\nPDF 元数据（抽查 4 份，含中/俄/英）");
const sample = ["resume-full.zh.pdf", "resume-full.ru.pdf", "resume-ai.en.pdf", "resume-en-1p.en.pdf"]
  .filter((f) => distPdfs.includes(f));
for (const f of sample) {
  const raw = readFileSync(join(distDir, f)).toString("latin1");
  const { title, author } = pdfInfo(raw);
  report(!!title && !!author, `${f}  Title="${(title ?? "(缺失)").slice(0, 34)}"  Author="${author ?? "(缺失)"}"`);
}

console.log(problems ? `\n✗ 产物完整性检查未通过：${problems} 项` : "\n✓ 产物完整性检查通过");
process.exit(problems ? 1 : 0);

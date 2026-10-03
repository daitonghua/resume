// PDF 内容量探测：不解析文本，只看"每页内容流画了多少东西"。
// 用途：在缺少可信文本提取能力的情况下，判断某页是否近乎空白、某段内容是否根本没画上去。
// 例：中文页若汉字都没被绘制，内容流会异常小（此前 PICK bug 就表现为这个特征）。
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function pageStats(file) {
  const buf = readFileSync(file);
  const s = buf.toString("latin1");
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = +m[1], pos = re.lastIndex;
    const sm = /stream\r?\n/.exec(s.slice(pos, pos + 4000));
    if (sm) {
      const dict = s.slice(pos, pos + sm.index);
      const start = pos + sm.index + sm[0].length;
      const lm = /\/Length\s+(\d+)/.exec(dict);
      const raw = buf.subarray(start, lm ? start + +lm[1] : s.indexOf("endstream", start));
      let stream = null;
      try { stream = /FlateDecode/.test(dict) ? inflateSync(raw).toString("latin1") : raw.toString("latin1"); } catch {}
      objs.set(num, { num, dict, stream });
    } else {
      const eo = s.indexOf("endobj", pos);
      objs.set(num, { num, dict: s.slice(pos, eo < 0 ? pos + 300 : eo), stream: null });
      if (eo > 0) re.lastIndex = eo;
    }
  }
  const pages = [...objs.values()].filter((o) => /\/Type\s*\/Page(?![s])/.test(o.dict));
  return pages.map((p, i) => {
    const refs = [...p.dict.matchAll(/\/Contents\s+(\d+)\s+\d+\s+R/g)].map((x) => +x[1]);
    let bytes = 0, ops = 0, hexChars = 0;
    for (const n of refs) {
      const st = objs.get(n)?.stream;
      if (!st) continue;
      bytes += st.length;
      ops += (st.match(/\bTj\b|\bTJ\b/g) || []).length;
      for (const h of st.matchAll(/<([0-9a-fA-F]+)>/g)) hexChars += h[1].length / 4;   // 字形数（≈字符数）
    }
    return { page: i + 1, bytes, ops, glyphs: Math.round(hexChars) };
  });
}

const files = process.argv.slice(2);
const targets = files.length ? files.map((f) => join(ROOT, f)) : [
  "dist/resume-full.zh.pdf", "dist/resume-full.en.pdf", "dist/resume-full.ru.pdf",
  "dist/resume-ai.zh.pdf", "dist/resume-sensing.zh.pdf",
].map((f) => join(ROOT, f));

console.log("每页内容量（字节 / 文本指令 / 字形数）\n" + "─".repeat(62));
for (const f of targets) {
  const name = f.split(/[\\/]/).pop();
  const stats = pageStats(f);
  console.log(`${name}  ${stats.length} 页`);
  for (const p of stats) {
    const flag = p.glyphs < 200 ? "  ← 该页字形很少" : "";
    console.log(`   p${p.page}: ${String(p.bytes).padStart(6)}B  ${String(p.ops).padStart(3)} 条  ${String(p.glyphs).padStart(5)} 字形${flag}`);
  }
  const total = stats.reduce((a, b) => a + b.glyphs, 0);
  console.log(`   合计字形 ${total}`);
}

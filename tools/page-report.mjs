// 逐页内容量报告：核对分页是否合理。
//
// 能可靠判定：每页的「文本绘制指令数」。实测锚点：
//   正常满页 ≈ 45~90 条；只有一两行内容 ≈ 4~25 条。
// 不可靠、因此不报：内容纵向 "reach"。原因见下方注释——反复试过三种写法都不稳，
// 与其报一个我不信的数字，不如只报能对得上的数。
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, process.argv[2] ?? "dist");

/** 按 /Length 精确切分间接对象（内嵌字体流里也含 "obj"，不能靠找下一个 obj 定界） */
function parseObjects(buf) {
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
  return objs;
}

// 空白页阈值：正文只有页脚时约 1~2 条指令、内容流 < 900B
const BLANK_OPS = 10;
const SPARSE_OPS = 30;      // 一页只有寥寥几行
const FULL_OPS = 45;

const files = readdirSync(DIR).filter((f) => f.endsWith(".pdf")).sort();
console.log("逐页内容量（按文本绘制指令数；满页约 45~90 条，十几条即内容很少）");
console.log("─".repeat(78));
let problems = 0, sparse = 0;

for (const f of files) {
  const buf = readFileSync(join(DIR, f));
  const objs = parseObjects(buf);
  const pageObjs = [...objs.values()].filter((o) => /\/Type\s*\/Page(?![s])/.test(o.dict));

  const rows = pageObjs.map((p) => {
    const refs = [...p.dict.matchAll(/\/Contents\s+(\d+)\s+\d+\s+R/g)].map((x) => +x[1]);
    let ops = 0, bytes = 0;
    for (const n of refs) {
      const st = objs.get(n)?.stream;
      if (!st) continue;
      bytes += st.length;
      ops += (st.match(/\bTj\b|\bTJ\b/g) || []).length;
    }
    return { ops, bytes };
  });

  const blanks = rows.map((r, i) => ({ i: i + 1, ...r })).filter((r) => r.ops < BLANK_OPS || r.bytes < 900);
  const last = rows[rows.length - 1];
  const lastSparse = rows.length > 1 && last.ops < SPARSE_OPS;
  const flag = blanks.length
    ? `✗ 空白页 p${blanks.map((b) => b.i).join(",")}`
    : lastSparse ? "· 末页内容较少" : "✓";
  if (blanks.length) problems++;
  if (lastSparse) sparse++;

  console.log(`${f.padEnd(28)} ${rows.length} 页  ${flag}`);
  console.log("   " + rows.map((r, i) => `p${i + 1}: ${String(r.ops).padStart(3)} 条 / ${(r.bytes / 1024).toFixed(1)}KB`).join("   "));
}
console.log("─".repeat(78));
console.log(problems ? `✗ ${problems} 份存在空白页` : "✓ 无空白页");
if (sparse) console.log(`· ${sparse} 份末页内容较少（可考虑收紧行距合并，或接受现状）`);

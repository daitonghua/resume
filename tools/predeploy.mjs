// 部署前预检：在推送之前把"会发布什么、有没有保密风险"一次讲清。
//
// 动机：`X bit` 是刻意用来避免公开 4-12 bit 这类细节的写法（见 data 里 comp.algorithm 的注释）。
// 但如果 内部文本文件 / 数据文件 也被推到公开仓库，这些数字就随仓库公开了 —— 与"用 X 保密"的意图冲突。
// 本脚本把这类冲突显式报出来，让人自己决定是否发布。
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));

const ignored = (rel) => {
  try { execFileSync("git", ["check-ignore", "-q", rel], { cwd: ROOT, stdio: "ignore" }); return true; }
  catch { return false; }
};

console.log("将发布到 GitHub Pages（访客可见）的关键文件");
const published = [".nojekyll", "index.html", "daitonghua.jpg",
  "dist/resume-full.zh.pdf", "dist/resume-full.en.pdf", "dist/resume-full.ru.pdf"];
for (const f of published) {
  console.log(`  ${existsSync(join(ROOT, f)) ? "·" : "✗"} ${ignored(f) ? "会被忽略(异常)" : "发布"}  ${f}`);
}

console.log("\n保密性核对：公开内容里出现过的数字/敏感表述");
const PUBLIC_FILES = ["index.html", ...["zh", "en", "ru"].map((l) => `dist/resume-full.${l}.pdf`)];
const INTERNAL_FILES = [
  ["文本编辑.md", "人工改文案用的中间文件"],
  ["data/resume.master.json", "唯一数据源"],
];
// 从公开产物里抽出"bit 位宽"相关数字
const blob = PUBLIC_FILES.filter((f) => existsSync(join(ROOT, f)))
  .map((f) => readFileSync(join(ROOT, f), "latin1")).join("\n");
const bits = [...new Set([...blob.matchAll(/(\d+)\s*[-–]\s*(\d+)\s*bit/gi)].map((m) => `${m[1]}-${m[2]} bit`))];
console.log(`  公开产物里出现的位宽数字: ${bits.length ? bits.join(", ") : "（无）"}`);
console.log(`  （data 里 comp.algorithm 用的是 "X bit" 占位，属刻意不公开；上面这些来自其他字段）`);

console.log("\n内部文件是否会被一起发布（若发布，其中的数字就随仓库公开）");
let warn = 0;
for (const [f, why] of INTERNAL_FILES) {
  if (!existsSync(join(ROOT, f))) continue;
  const willPublish = !ignored(f);
  if (willPublish) {
    const hits = [...new Set([...readFileSync(join(ROOT, f), "utf8").matchAll(/(\d+)\s*[-–]\s*(\d+)\s*bit/gi)].map((m) => `${m[1]}-${m[2]} bit`))];
    warn++;
    console.log(`  ⚠ 会发布: ${f}（${why}）${hits.length ? `，含位宽数字 ${hits.join(", ")}` : ""}`);
  } else {
    console.log(`  · 不发布: ${f}（${why}）`);
  }
}
if (!warn) console.log("  ✓ 无：内部文件（数据源、文本编辑.md、构建信息）均不会发布");
else console.log("\n  ⚠ 上面标 ⚠ 的文件会随公开仓库一起公开，请确认这些内容可以对外。");

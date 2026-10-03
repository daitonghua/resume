// 下载链接核对：网页里的 PDF 下载链接必须对应真实文件，且该文件会被 git 发布
// （否则推到 GitHub Pages 后点下载就是 404 —— 本地怎么试都正常，线上才暴露）。
//
// 同时反向核对：内部裁剪版 PDF **不得**被发布上线。
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));

/** 是否会被 git 忽略。
 *  用 `git check-ignore -q <path>`：退出码 0 = 被忽略，1 = 未被忽略。
 *  注意不能靠"execFileSync 是否抛异常"判断——Windows 下退出码非 0 不一定抛。 */
function ignored(rel) {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 从产物里抽下载链接：动态页里路径是拼接的（'dist/resume-full.' + lang + '.pdf'），
// 所以先按前缀/后缀匹配，再拼出完整文件名。
const hasDlTemplate = /dist\/resume-full\.'\s*\+\s*lang\s*\+\s*'\.pdf/.test(html);
const expectedDl = ["zh", "en", "ru"].map((l) => `dist/resume-full.${l}.pdf`);

let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fail++; };

console.log("下载入口");
check(hasDlTemplate, "网页含 dist/resume-full.<lang>.pdf 下载链接（按当前语言）");
check(html.includes("docDownload") && html.includes(".dl-wrap"), "下载按钮容器与样式已注入");

console.log("\n下载文件（三份完整版）");
for (const rel of expectedDl) {
  const abs = join(ROOT, rel);
  const onDisk = existsSync(abs);
  const willPublish = !ignored(rel);
  const size = onDisk ? (statSync(abs).size / 1024).toFixed(0) + " KB" : "-";
  check(onDisk && willPublish, `${rel.padEnd(30)} ${size.padStart(8)}  ${onDisk ? "文件存在" : "文件缺失"} / ${willPublish ? "git 会发布" : "git 忽略 → 线上 404"}`);
}

console.log("\n内部裁剪版不得发布");
const variantKeys = Object.keys(data.variants).filter((k) => k !== "full");
let leaked = 0;
for (const k of variantKeys) {
  for (const lang of data.variants[k].langs) {
    const rel = `dist/resume-${k}.${lang}.pdf`;
    if (!existsSync(join(ROOT, rel))) continue;
    if (!ignored(rel)) { leaked++; check(false, `${rel} 是内部裁剪版，却被纳入发布`); }
  }
}
if (!leaked) check(true, `${variantKeys.length} 个裁剪版的 PDF 全部未纳入发布`);

console.log("\n其他产物");
check(!ignored("index.html"), "index.html 会发布（GitHub Pages 首页）");
check(!ignored("daitonghua.jpg"), "头像会发布");
check(!ignored(".nojekyll"), ".nojekyll 会发布（避免 Jekyll 处理）");
check(ignored("build-manifest.json"), "build-manifest.json 不发布（内部构建信息）");
check(ignored("dist/pdf-manifest.json"), "dist/pdf-manifest.json 不发布（内部构建信息）");

console.log(fail ? `\n✗ 下载链接核对未通过：${fail} 项` : "\n✓ 下载链接核对通过");
process.exit(fail ? 1 : 0);

// 线上部署验证：确认 GitHub Pages 上跑的确实是当前仓库内容。
// 用法: node tools/verify-live.mjs            （默认 https://daitonghua.github.io/resume）
//       node tools/verify-live.mjs <baseUrl>
//
// 判据（都是"只有新版才可能出现"的标记，避免旧版误判通过）：
//   1) 首页含版本切换器（variantSel）与新版定位语（算法-硬件协同设计）
//   2) 首页内嵌数据里的内容哈希与本地 build-manifest.json 一致
//   3) 每个静态版本页都能 200，且含对应语言的正文标记
//   4) 不再出现旧版标题（中射频算法工程师）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.argv[2] ?? "https://daitonghua.github.io/resume").replace(/\/$/, "");
const manifest = JSON.parse(readFileSync(join(ROOT, "build-manifest.json"), "utf8"));
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));

const get = async (path) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BASE + path, { signal: ctl.signal, headers: { "cache-control": "no-cache" } });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: "", error: e.message };
  } finally { clearTimeout(t); }
};

let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};

console.log(`\n线上验证: ${BASE}\n内容哈希(本地构建): ${manifest.contentHash}\n`);

// 1) 首页
const home = await get("/");
if (home.status !== 200) {
  console.log(`  ✗ 首页无法访问（HTTP ${home.status}${home.error ? " " + home.error : ""}）`);
  console.log("\n提示：若刚推送，Pages 需要 1-2 分钟构建；也可检查仓库 Settings → Pages 是否指向 root。");
  process.exit(1);
}
console.log(`首页 HTTP ${home.status}，${(home.body.length / 1024).toFixed(1)} KB`);
check(home.body.includes("variantSel"), "含版本切换器（新版动态主页）");
check(home.body.includes("算法-硬件协同设计"), "含新版定位语");
check(!home.body.includes("中射频算法工程师"), "已不含旧版标题");
check(home.body.includes(manifest.contentHash), "内嵌数据哈希与本地一致", manifest.contentHash);

// 2) 静态版本页
for (const p of manifest.pages) {
  const r = await get("/" + p.path);
  const lang = p.lang;
  const sample = data.sections.experience.title[lang];
  const ok = r.status === 200 && r.body.includes(sample);
  check(ok, `${p.path.padEnd(22)} HTTP ${r.status}`, ok ? "" : `缺少"${sample}"`);
}

// 3) 静态资源
const img = await get("/daitonghua.jpg");
check(img.status === 200, "头像 daitonghua.jpg 可访问");

console.log(fail ? `\n✗ 线上验证未通过：${fail} 项` : "\n✓ 线上验证通过：GitHub Pages 已是当前仓库内容");
process.exit(fail ? 1 : 0);

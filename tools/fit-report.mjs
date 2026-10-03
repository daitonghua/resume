// 版面余量报告：在**内存里**跑排版，不上盘，直接算出"末页溢出/剩余多少 pt"。
//
// 为什么需要它：pnpm verify 只告诉我们"3 页 ≠ 2 页"，不告诉我们差多少。
// 差 20pt 只需微调行距，差 200pt 就得删内容 —— 判断依据不同，方案完全不同。
// 本工具用 layout() 的 onNode 钩子拿到每个节点渲染前后的 y 与页号，因此可以回答：
//   · 末页实际占用多少 pt、还差多少才能收进上一页
//   · 每个板块/条目各占多高（找出最占地方的内容）
//
// 用法：node tools/fit-report.mjs [变体] [语言...]
//   例：node tools/fit-report.mjs full en ru
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { layout, resolveFonts, S } from "../src/pdf.mjs";
import { makeSelectNodes } from "../src/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));
const selectNodes = makeSelectNodes(data);
const { fonts } = resolveFonts();

const argv = process.argv.slice(2);
const variantFilter = argv[0] ? [argv[0]] : Object.keys(data.variants);
const langFilter = argv.slice(1);

// 试验用：允许从命令行覆盖排版参数，用来回答"还能省多少 pt"。
//   例：node tools/fit-report.mjs full en --bul=7.9 --lead=11.5 --gapk=0.95
// 只影响本次内存测量，不改数据、不写盘。
const num = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq) return Number(eq.slice(name.length + 1));
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const OV = { bul: num("--bul", null), lead: num("--lead", null), gapk: num("--gapk", 1) };

for (const key of variantFilter) {
  const variant = data.variants[key];
  if (!variant) { console.error(`✗ 未知变体: ${key}`); process.exit(1); }
  for (const lang of variant.langs) {
    if (langFilter.length && !langFilter.includes(lang)) continue;

    const doc = new PDFDocument({ ...S.page, autoFirstPage: true, bufferPages: true });
    for (const [k, p] of Object.entries(fonts)) doc.registerFont(k, p);
    doc.pipe({ write() {}, end() {}, on() {}, once() {}, emit() {}, emit2() {} });

    // 记录每一次真正落到纸上的文字位置（页对象 → 最低 y）。
    // 这比用节点 trace 推更可靠：节点的 y1 不包含页脚等"不经过 onNode 的绘制"。
    const pagePts = [];
    const seenPage = (pg) => {
      let i = pagePts.findIndex((e) => e.pg === pg);
      if (i < 0) { pagePts.push({ pg, pts: [] }); i = pagePts.length - 1; }
      return i;
    };
    const origText = doc.text.bind(doc);
    doc.text = function (t, ...rest) {
      // 必须在绘制**之前**记录：pdfkit 画完会把 doc.y 推到下一行。
      const before = this.y;
      if (typeof t === "string" && t.length) pagePts[seenPage(this.page)].pts.push(before);
      return origText(t, ...rest);
    };

    const trace = [];
    // 只测量：不上盘（doc 的流被丢进空写口），纯粹看几何。
    // 试验参数走"临时变体"：layout 内部是【先应用 compactValues，再排版】，
    // 所以直接改全局 S 会被 compactValues 覆盖回去 —— 必须让覆盖值走在最后一步。
    const probeData = { ...data, variants: { ...data.variants, [key]: { ...variant } } };
    if (OV.bul != null || OV.lead != null || OV.gapk !== 1) {
      const base = variant.compactValues ?? { size: {}, gap: {} };
      const cv = { size: { ...base.size }, gap: { ...base.gap }, lead: base.lead };
      if (OV.bul != null) { cv.size.body = OV.bul; cv.size.bullet = OV.bul; }
      if (OV.lead != null) cv.lead = OV.lead;
      if (OV.gapk !== 1) for (const k of Object.keys(S.gap)) cv.gap[k] = (cv.gap[k] ?? S.gap[k]) * OV.gapk;
      probeData.variants[key].compactValues = cv;
    }
    layout(doc, probeData, key, lang, selectNodes, (info) => trace.push(info));
    if (process.env.DBG) {
      const cv = probeData.variants[key].compactValues;
      console.log(`   [DBG] OV=${JSON.stringify(OV)} body=${cv?.size?.body} lead=${cv?.lead} gapSection=${cv?.gap?.section}`);
    }
    const pages = doc.bufferedPageRange().count;
    const M = doc.page.margins;
    const pageH = doc.page.height - M.top - M.bottom;

    // 正文占用高度：页脚画在"下边距之下 + 6"的固定位置，每页都有，
    // 直接取最低点会被页脚钉死成同一个值（实测每页都是 758）——必须按位置剔除。
    const footerY = doc.page.height - M.bottom + 6;
    const perPage = pagePts.map((e) => {
      const body = e.pts.filter((y) => y < footerY - 4);
      const low = body.length ? Math.max(...body) : 0;
      return Math.round(low - M.top);
    });
    const used = perPage[perPage.length - 1] ?? 0;
    const slack = pageH - used;

    console.log(`── ${key}/${lang}  ${pages} 页  单页可用 ${Math.round(pageH)}pt  各页占用 ${perPage.join("/")}pt`);
    if (pages > 1) {
      if (slack >= 0) {
        console.log(`   末页占用 ${used}pt（还剩 ${Math.round(slack)}pt）—— 已收进 ${pages} 页`);
      } else {
        console.log(`   末页溢出 ${Math.round(-slack)}pt：需要再省出这么多才能收进第 ${pages - 1} 页`);
      }
    }
    // 本期每个节点占高（按板块累计），用于判断"该砍谁/该压谁"
    const byNode = new Map();
    for (const t of trace) {
      const h = t.pagesAfter > t.pagesBefore
        ? (pageH - (t.y0 - M.top)) + (t.y1 - M.top)
        : (t.y1 - t.y0);
      byNode.set(t.id, (byNode.get(t.id) ?? 0) + h);
    }
    const rows = [...byNode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log("   占高最大的节点: " + rows.map(([id, h]) => `${id}=${Math.round(h)}pt`).join(" "));
  }
}

// 上线洁净性校验。守住两条相反的边界：
//   ✅ 语言切换（中文/EN/RU）—— 是简历的正常功能，上线对访客可见
//   ❌ 版本切换与版本名（"AI 芯片量化版"等）—— 内部信息，上线绝不出现
//
// 之所以要有这个文件：这两者都走同一个顶栏，改动时极易把内部信息一起放出去。
// 曾经版本名出现在页脚、?v=ai 出现在地址栏，就是这类失误。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
const dataJson = /<script id="resume-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
// 读取数据源，用于推导期望值（避免把标题写死在校验里）
const data = JSON.parse(readFileSync(join(ROOT, "data", "resume.master.json"), "utf8"));

/** 用最小 DOM 桩执行内嵌脚本。桩需要覆盖脚本真正用到的那部分 DOM API：
 *  元素（含 closest/addEventListener/offsetTop）、window 的滚动与事件、history.replaceState。 */
function run(search, { clickLang, clickNav, navProbe, navHighlightProbe } = {}) {
  const els = {};
  const handlers = {};
  const mk = (id) => (els[id] ??= {
    id, innerHTML: "", textContent: "", value: "", hidden: true, disabled: false, offsetTop: 0, offsetHeight: 60,
    style: { setProperty() {} }, dataset: {}, classList: { toggle() {} },
    getAttribute() { return null; },
    closest() { return null; },
    // 滚动定位与高亮判定现在用 getBoundingClientRect（offsetTop 在祖先有定位时会算错），
    // 桩必须提供它，否则脚本一执行就抛错（曾因此报 TypeError）
    getBoundingClientRect() { return { top: this.__top ?? 0, height: this.offsetHeight ?? 0, left: 0, width: 0, bottom: 0, right: 0 }; },
    addEventListener(ev, fn) { (handlers[id] ??= {})[ev] = fn; },
    querySelectorAll: () => [],
  });
  const buttons = ["zh", "en", "ru"].map((l) => ({ tagName: "BUTTON", dataset: { lang: l }, disabled: false, style: {}, classList: { toggle() {} } }));
  const seg = mk("langSeg"); seg.querySelectorAll = () => buttons;
  // 导航链接桩：点击时能拿到 href，供"点击导航跳转"的验证
  const navLinks = [];
  [...dataJson.matchAll(/"(sections)"/g)];   // 占位，真实链接在渲染后由 innerHTML 决定
  const navEl = mk("sectionNav");
  // 链接元素桩：从渲染出的 innerHTML 解析出真实元素，并让 syncNav 的 querySelectorAll
  // 返回**同一批对象** —— 否则 syncNav 改的 className 与测试读的对象不是同一个，
  // 高亮断言会永远失败（曾因此误判"高亮指向最后一个栏目"）。
  let linkEls = [];
  navEl.querySelectorAll = () => linkEls;
  globalThis.__rebuildNavLinks = () => {
    linkEls = [...String(navEl.innerHTML).matchAll(/href="(#[^"]+)"[^>]*>([^<]*)</g)].map((m) => {
      const el = {
        className: "", href: m[1], textContent: m[2], style: {}, dataset: {},
        getAttribute: () => m[1],
        getBoundingClientRect: () => ({ top: 0, height: 0, left: 0, width: 0, bottom: 0, right: 0 }),
      };
      return el;
    });
  };
  els["resume-data"] = { textContent: dataJson };
  // 板块锚点元素：按需创建，使滚动高亮脚本能拿到 offsetTop。
  // 关键：板块列表只解析一次并缓存。早先每次调用都重新解析 docBody.innerHTML，
  // 一旦语句顺序稍有变化（如多一行调试输出）就可能读到空列表，
  // 表现为"探针结果随无关改动漂移"——排查了很久的假象。
  let secIds = null;
  const sectionsIn = () => (secIds ??= [...(els.docBody?.innerHTML ?? "").matchAll(/id="(sec-[a-z]+)"/g)].map((m) => m[1]));
  globalThis.document = {
    // 刻意只返回"真实存在"的元素：未知 id 返回 null。
    // 早先的实现对任何 id 都 mk() 出一个新桩（rect.top=0 且高度 60），
    // 于是 getElementById('sec' + href.slice(3)) 找不到真板块时也拿到一个
    // 假元素、top 恒为 0，高亮判定被它带偏 —— 探针因此读了半天假结果。
    getElementById: (id) => {
      if (els[id]) return els[id];                       // 已建好的桩优先（如 sectionNav / bar）
      if (id.startsWith("sec-")) {
        if (!sectionsIn().includes(id)) return null;   // 真页面里就是这个行为
        return (els[id] = { ...mk(id), offsetTop: 100 + 400 * sectionsIn().indexOf(id) });
      }
      if (id.startsWith("sec")) return null;
      return mk(id);
    },
    querySelectorAll: (sel) => (sel === "#langSeg button" ? buttons : []),
    documentElement: { style: { setProperty() {} } },
  };
  let lastUrl = null, scrolledTo = null;
  globalThis.location = { href: "http://x/", search };
  globalThis.history = { replaceState: (_a, _b, u) => { lastUrl = String(u); } };
  globalThis.setTimeout = () => {};
  globalThis.window = {
    __NAVDBG: !!process.env.DBG,
    print() {}, pageYOffset: 0,
    addEventListener() {},
    scrollTo(o) { scrolledTo = o; },
  };
  new Function(script)();

  // 可选：模拟点语言按钮
  let afterClick = null;
  if (clickLang && handlers.langSeg?.click) {
    const target = buttons.find((b) => b.dataset.lang === clickLang);
    handlers.langSeg.click({ target });
    afterClick = { body: els.docBody.innerHTML, footer: els.docFoot.innerHTML, dl: els.docDownload.innerHTML, url: lastUrl };
  }
  // 可选：模拟点栏目导航。
  // 注意：点击处理里会用 getElementById 找目标板块，找不到就直接 return（不滚动）。
  // 桩把未知 id 也当假元素是最初的 bug 来源，所以这里必须预建真实板块桩。
  let navClick = null;
  if (clickNav && handlers.sectionNav?.click) {
    sectionsIn().forEach((id) => document.getElementById(id));
    const href = `#sec-${clickNav}`;
    const a = { getAttribute: () => href, closest: () => a };
    handlers.sectionNav.click({ target: a, preventDefault() {} });
    navClick = { href, scrolledTo };
  }

  // 可选：驱动滚动高亮（把第 3 个板块的 rect.top 设到吸顶栏之下，其余按上下排布），
  // 再调用脚本注册到 window.__syncNav 的函数，读出哪个链接被点亮。
  // 行为验证：直接调用脚本暴露的 window.__navCurrent()，检查它给出的 href 是否符合预期。
  // 做法：把每个板块的 rect.top 摆成"第 i 个正好越过吸顶栏"，其余按 300px 间距排列，
  // 然后问 __navCurrent()：应高亮第 i 个。
  let navAnswers = null;
  if (navHighlightProbe) {
    globalThis.__rebuildNavLinks();   // 必须在调用 __navCurrent() 之前建好链接桩，否则 navEl.querySelectorAll('a') 为空
    const ids = sectionsIn();
    const anchors = ids.map((id) => document.getElementById(id));
    const fn = globalThis.window.__navCurrent;
    if (typeof fn === "function" && anchors.length) {
      navAnswers = [];
      for (let k = 0; k < anchors.length; k++) {
        // 让第 k 个板块的 top 恰好为 0（越过吸顶栏），前面的为负、后面的为正
        anchors.forEach((a, i) => { a.__top = (i - k) * 300; });
        navAnswers.push({ i: k, expect: "#" + ids[k], got: fn() });
      }
    }
  }

  let navHighlight = null;
  if (navProbe) {
    const anchors = sectionsIn().map((id) => document.getElementById(id));
    // 第 3 个板块(i=2) 的 top 设为 0，即"刚好越过吸顶栏"；其余按 300px 间距上下排布
    anchors.forEach((a, i) => { a.__top = (i - 3) * 300; });   // 第 4 个(i=3) top=0，刚好越过吸顶栏
    if (process.env.DBG) console.log("DEBUG anchor objs:", anchors.map((a) => a.id + ":" + a.__top).join(" "));
    if (process.env.DBG) console.log("DEBUG same obj:", anchors[0] === document.getElementById("sec-competency"), " rect:", JSON.stringify(document.getElementById("sec-competency").getBoundingClientRect()));
    if (process.env.DBG) console.log("DEBUG tops:", sectionsIn().map(id => id + "=" + document.getElementById(id).getBoundingClientRect().top).join(" "));
    const sync = globalThis.window.__syncNav;
    if (process.env.DBG) {
      console.log("DEBUG sync type:", typeof sync);
      console.log("DEBUG window keys:", Object.keys(globalThis.window).join(","));
      console.log("DEBUG anchors:", sectionsIn().length, "linkEls:", navEl.querySelectorAll().length);
      console.log("DEBUG innerHTML len:", String(navEl.innerHTML).length);
    }
    if (typeof sync === "function") {
      sync();
      // 必须在 sync() **之后**重建链接桩：syncNav 改的是它自己 querySelectorAll 取到的元素，
      // 而我这些桩是另建的 —— 重建时机错了就会读到旧的 className（曾因此误判高亮对象）
      globalThis.__rebuildNavLinks && globalThis.__rebuildNavLinks();
      const links = navEl.querySelectorAll();
      const onHrefs = links.filter((l) => l.className === "on").map((l) => l.getAttribute("href"));
      if (process.env.DBG) console.log("DEBUG links:", links.map((l) => l.getAttribute("href") + ":" + (l.className || "-")).join(" "));
      const expectHref = "#" + sectionsIn()[3];   // sectionsIn 已含 sec- 前缀
      navHighlight = {
        expectHref,
        onHrefs,
        ok: onHrefs.length === 1 && onHrefs[0] === expectHref,
      };

    }
  }
  return {
    barVisible: els.bar ? els.bar.hidden === false : false,
    verGroupVisible: els.verGroup ? els.verGroup.hidden === false : false,
    footer: els.docFoot?.innerHTML ?? "",
    note: els.variantNote?.innerHTML ?? "",
    navHtml: els.sectionNav?.innerHTML ?? "",
    url: lastUrl,
    sections: sectionsIn(),
    body: els.docBody?.innerHTML ?? "",
    dl: els.docDownload?.innerHTML ?? "",
    afterClick,
    navHighlight,
    navAnswers,
    navClick,
  };
}

let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fail++; };
const VERSION_WORDS = ["AI 芯片量化版", "AI-Chip", "通信 / DPD 版", "无线感知 / 研究版", "通用海投版", "General One-Pager", "英文单页精简版", "完整版（全部内容）"];

console.log("默认访问（上线后的样子）");
const prod = run("");
check(prod.barVisible, "顶栏可见（语言切换是上线功能）");
check(!prod.verGroupVisible, "「版本」下拉框隐藏（内部功能）");
for (const w of VERSION_WORDS) check(!prod.footer.includes(w) && !prod.body.includes(w), `正文与页脚不含版本名「${w}」`);
check(!prod.footer.includes("版"), `页脚不含「版」字样（实际: ${prod.footer.replace(/<[^>]+>/g, "") || "（空）"}）`);
check(prod.note === "", "不显示版本目标提示（内部信息）");
check(prod.url === "http://x/", `URL 保持干净（实际: ${prod.url}）`);
check(prod.sections.length > 0, `正文正常渲染（${prod.sections.length} 个板块）`);

console.log("\n语言切换（上线可用）");
for (const [lang, probe] of [["en", "Dai Tonghua"], ["ru", "Дай Тунхуа"]]) {
  const r = run(`?lang=${lang}`);
  check(r.body.includes(probe), `?lang=${lang} 直达：正文含「${probe}」`);
  check(r.url.includes(`lang=${lang}`), `?lang=${lang} 的 URL 可分享`);
  check(r.dl.includes(`resume-full.${lang}.pdf`), `?lang=${lang} 时下载按钮指向 ${lang} 版 PDF`);
  check(!r.verGroupVisible, `?lang=${lang} 时不出现版本下拉框`);
}
const zh = run("");
check(zh.dl.includes("resume-full.zh.pdf"), "默认（中文）下载按钮指向中文版 PDF");

console.log("\n点击语言按钮真的会切换（不只是有按钮）");
const clicked = run("", { clickLang: "en" });
check(clicked.afterClick?.body.includes("Dai Tonghua"), "点击 English 后正文变英文");
check(clicked.afterClick?.dl.includes("resume-full.en.pdf"), "点击 English 后下载链接跟着切到英文版");
check(clicked.afterClick?.url?.includes("lang=en"), "点击 English 后 URL 同步为 ?lang=en");
check(!clicked.afterClick?.body.includes("戴瞳华"), "切换后不再残留中文正文");

console.log("\n栏目导航（上线可用）");
{
  const r = run("");
  const navLinks = [...r.navHtml.matchAll(/href="#(sec-[a-z]+)"/g)].map((m) => m[1]);
  check(navLinks.length > 0, `导航生成了 ${navLinks.length} 个栏目链接`);
  check(navLinks.length === r.sections.length, `导航链接数 (${navLinks.length}) 与正文板块数 (${r.sections.length}) 一致`);
  // 每个链接都必须有对应的板块锚点，否则点了没反应
  const missing = navLinks.filter((id) => !r.sections.includes(id));
  check(missing.length === 0, `每个导航链接都有对应锚点${missing.length ? "；缺: " + missing.join(", ") : ""}`);
  // 导航文字应取当前语言的板块标题。这里从数据读取期望值而不是写死字符串——
  // 写死会在改标题后误报（本项目刚因此报了一次假失败）。
  const firstSecId = navLinks[0]?.replace("sec-", "");
  const expectZh = data.sections[firstSecId]?.title?.zh ?? "";
  const firstText = /<a href="#sec-[a-z]+"[^>]*>([^<]*)<\/a>/.exec(r.navHtml)?.[1] ?? "";
  check(expectZh && firstText === expectZh, `导航文字用当前语言（首项: ${firstText} == 数据里的「${expectZh}」）`);
  check(!/版/.test(r.navHtml), "导航里不含任何版本名");

  // 点击导航应滚动到对应板块并更新 URL 锚点
  const clicked = run("", { clickNav: "experience" });
  check(clicked.navClick?.scrolledTo?.top >= 0, `点击导航触发滚动（top=${clicked.navClick?.scrolledTo?.top}）`);
  check(clicked.navClick?.scrolledTo?.behavior === "smooth", "滚动为平滑动画");

  // 切到英文后导航文字也要跟着变
  const en = run("?lang=en");
  const enFirst = /<a href="#sec-[a-z]+"[^>]*>([^<]*)<\/a>/.exec(en.navHtml)?.[1] ?? "";
  check(enFirst === (data.sections[firstSecId]?.title?.en ?? ""), `切到英文后导航文字随之变化（首项: ${enFirst}）`);

  // 滚动高亮：静态检查实现要点 + 行为验证（脚本暴露了 window.__navCurrent() 专供测试，
  // 不必再去猜 DOM 里的 className —— 之前就是靠猜，反复误报）。
  check(/getBoundingClientRect\(\)\.top/.test(html), "高亮位置用 getBoundingClientRect（不用 offsetTop）");
  check(/top <= limit && top > bestTop/.test(html), "取「已越过吸顶栏且位置最靠下」的板块（不是 offsetTop 那套）");
  check(/document\.getElementById\(href\.slice\(1\)\)/.test(html), "锚点 id 由 href 正确推导（曾写成 slice(3)，导致高亮永远停在第一项）");
  check(/addEventListener\('scroll'/.test(html), "监听 scroll 跟随滚动");
  check(/addEventListener\('hashchange'/.test(html), "监听 hashchange 跟随深链接");
  check(/apply\(href\);/.test(html), "点击导航后立即更新高亮（不等 scroll 事件）");
  check(/flex-wrap:nowrap/.test(html), "顶栏不换行（导航不会掉到第二行）");
  check(/@media \(min-width:1180px\)/.test(html) && /@media \(min-width:1500px\)/.test(html), "宽屏放宽内容宽度（两档断点）");

  // 行为验证：把板块摆成真实布局（y 递增），逐个滚动位置核对 __navCurrent() 的答案
  {
    const rows = run("", { navHighlightProbe: true });
    if (!rows.navAnswers) {
      check(false, "探针未能驱动 __navCurrent()");
    } else {
      let bad = 0;
      for (const r of rows.navAnswers) {
        if (r.got !== r.expect) { bad++; console.log(`      · 第 ${r.i + 1} 个板块位置：期望 ${r.expect}，实际 ${r.got}`); }
      }
      check(bad === 0, `${rows.navAnswers.length} 个滚动位置的高亮全部正确`);
    }
  }
}

console.log("\n?dev=1（我自己调版式用）");
const dev = run("?dev=1");
check(dev.verGroupVisible, "版本下拉框显示");
check(/版/.test(dev.footer), "页脚显示版本名（便于区分）");
check(dev.url.includes("v="), "URL 同步版本参数");

console.log("\n?lang=en&v=ai（非 dev 时应忽略版本参数）");
const sneaky = run("?lang=en&v=ai");
check(!sneaky.verGroupVisible, "版本下拉框仍隐藏");
check(!sneaky.body.includes("AI-Chip") && !/AI 芯片量化/.test(sneaky.footer), "未被 URL 参数切到裁剪版");
check(sneaky.body.includes("Dai Tonghua"), "语言参数生效（英文）+ 版本被忽略（完整版）");
check(!/[?&]v=/.test(sneaky.url ?? ""), `URL 被清理掉版本参数（实际: ${sneaky.url}）`);

console.log(fail ? `\n✗ 上线洁净性未通过：${fail} 项` : "\n✓ 上线洁净性通过：语言切换可用，内部版本信息零泄露");
process.exit(fail ? 1 : 0);

# 简历（网站 + PDF 同一数据源）

戴瞳华的个人简历：一份 JSON 数据源，同时生成**现代极简的个人网站**与**传统单栏 PDF**，
并按岗位需求快速裁剪出多个版本。

- 线上网站：https://daitonghua.github.io/resume/
- 旧版留档：`../resume_old`（重构前的单文件 index.html，含旧数据口径，勿回填）

---

## 一句话用法

```bash
pnpm install            # 首次
pnpm build              # 改完内容后：生成网站
pnpm pdf                # 生成 PDF
pnpm all                # 两者一起
pnpm check              # 自检：数据是否合法、产物是否与数据一致
```

---

## 目录结构

```
resume/
├── data/resume.master.json   ★ 唯一内容真相（三语全部内容 + 版本配置）
├── src/
│   ├── render.mjs            类型化渲染器（HTML 与 PDF 共用同一套裁剪逻辑）
│   ├── styles.mjs            现代极简样式（含 @media print）
│   ├── web.mjs               动态主页 + 静态版本页组装
│   └── pdf.mjs               pdfkit 传统单栏排版层 + 字体路由
├── tools/
│   ├── build.mjs             构建网页（index.html + v/*.html + build-manifest.json）
│   ├── build-pdf.mjs         构建 PDF（dist/*.pdf）
│   ├── validate.mjs          数据校验（节点/语言/版本引用/tag 拼写）
│   └── verify-pdf.mjs        PDF 校验（页数 + 字体嵌入 + ToUnicode 可提取性）
├── v/                       构建产物：各版本静态页（v/<版本>.<语言>.html）
├── dist/                    构建产物：PDF（dist/resume-<版本>.<语言>.pdf）
├── index.html               构建产物：动态主页（GitHub Pages 首页）
└── daitonghua.jpg
```

**产物不要手改**——它们带数据哈希，`pnpm check` 会校验一致性。

---

## 改内容（最常用）

只需动 `data/resume.master.json` 的 `nodes`：

```jsonc
"comp.sensing": {                     // 节点 id：稳定、唯一，被版本引用
  "type": "bullet",                   // 渲染类型，决定用哪个渲染器
  "level": 1,                         // 1=核心 2=有力补充 3=课程级细节（1页版会砍 3）
  "tags": ["sensing"],                // 主题标签，版本按它裁剪
  "text": { "zh": "…", "en": "…", "ru": "…" }   // 三语必须齐全，否则校验报错
}
```

加完节点记得放进 `order.default`（校验器会检查是否遗漏）。

---

## 裁剪版本（投不同岗位用）

版本配置在同一个 JSON 的 `variants` 里，有**四条裁剪轴**：

| 轴 | 字段 | 作用 |
|---|---|---|
| 排除节点 | `dropNodes: ["research.phd"]` | 整条删掉 |
| 按主题排除 | `dropTags: ["sensing"]` | 带该标签的节点/子条目全删（AI 版不要无线感知） |
| 子条目白名单 | `keepTagsAny: ["sensing","quant"]` | 只保留命中标签的子条目（用于研究版聚焦） |
| 按详略 | `maxLevel: 2` | 砍掉 level 3 的课程级细节 |
| 版式紧凑 | `compactLangs: ["en"]` | 该语言在基准值上按比例收紧间隔/行距 |
| 精确排版 | `compactValues: {...}` | 直接给出目标字号/行距/间隔（用于"完整版压到 2 页"这类需要精确控制的场景） |

外加 `sectionOrder` 控制板块顺序（研究岗可把「科研项目」提到「工作经历」前）、
`langs` 控制该版本出哪些语言。

> `compactLangs` 的由来：AI 版与 DPD 版的**英文**版原本各自溢出到第 2 页，而第 2 页只有一两行
> （实测仅 4 条文本指令），中文版同样内容 1 页装得下——这是版式问题而非内容量问题。
> 所以对英文启用紧凑模式拉回 1 页，而不是删内容。

**裁剪只删不改**：任何版本里的每句话都取自主版同一个节点，
所以不会出现"小简历和大简历说法不一致"。

现有版本：

| key | 版本 | 目标 | 语言 |
|---|---|---|---|
| `full` | 完整版（全部内容，**2 页**） | 通用底稿 | zh / en / ru |
| `ai` | AI 芯片量化版 | 华为昇腾 / 寒武纪 / 地平线 / 摩尔线程 | zh / en |
| `dpd` | 通信 DPD 版 | 紫光展锐 / 中兴微 / 海思中射频 | zh / en |
| `sensing` | 无线感知 / 研究版 | 研究院 / 博士后 / Google Soli / Infineon / Apple | zh / en / ru |
| `general` | 通用海投版 | 海投 | zh / en |
| `en-1p` | 英文单页精简版 | 海外岗位 / 猎头 | en |

---

## 出 PDF

```bash
pnpm pdf                       # 全部 13 份
node tools/build-pdf.mjs ai    # 只要 AI 版
node tools/build-pdf.mjs ai --lang zh
node tools/build-pdf.mjs --report ai --lang en   # 逐节点输出所在页码与占高（核对分页）
pnpm verify                    # 校验页数、字体嵌入、文本可提取性、空白页
pnpm page-report               # 逐页内容量（核对有没有"一页只放了一行"）
```

**当前页数**：完整版 **2 页**（中/英/俄）；AI 芯片版、通信 DPD 版、通用海投版、英文单页版各 1 页；无线感知版 2 页。

完整版的 2 页是通过 `variants.full.compactValues` 里的**绝对排版参数**实现的
（字号约 8.1pt、行距 12.05pt、板块间隔压到 0.72 倍）。想放宽观感就改这组数值——
但英文/俄文比中文长，改动后务必跑 `pnpm verify`（它把"完整版必须是 2 页"写成了硬断言）。

产物：`dist/resume-<版本>.<语言>.pdf`。

**PDF 是文字型的**（可选中、可搜索、ATS 可解析）：字体做了子集嵌入，每份仅 60–110 KB。
由于本机 Chrome 的无头打印被环境阻断（mojo IPC 命名管道拒绝），
PDF 不走浏览器打印，而由 `pdfkit` 直接排版 —— 好处是输出不受浏览器设置影响，每次都一致。

### 字体路由（三语混排的关键）

一份简历里中英俄混排（如「博士 — HSE 大学」），pdfkit 单次 `text()` 只能用一个字体，
所以 `src/pdf.mjs` 按码点选字体：

| 用途 | 字体 |
|---|---|
| 中文正文 | `C:\Windows\Fonts\Deng.ttf`（等线） |
| 中文标题/加粗 | `C:\Windows\Fonts\simhei.ttf`（黑体本身就是粗体，无需字重文件） |
| 拉丁 + 西里尔 | `C:\Windows\Fonts\arial.ttf` / `arialbd.ttf` / `ariali.ttf` |

> ⚠️ 不要用 `NotoSansSC-VF.ttf` 作正文：它是可变字体，默认字重 100（Thin），
> pdfkit 无法实例化字重，会渲染出极细的字。

---

## 网页

**上线形态（默认访问）：完整版简历 + 语言切换。** 访客可见：

- **语言切换按钮**（中文 / English / Русский）—— 正常功能，可分享 `?lang=en` 直链
- **PDF 下载按钮** —— 按当前语言给对应的完整版 PDF
- 页脚只有更新日期；**不显示内部版本名**（如"AI 芯片量化版"），地址栏也不会出现 `?v=ai` 这类内部参数

**内部调试形态：加 `?dev=1`。** 这时才显示语言与版本切换器、页脚版本名、各版本目标提示，
便于我按岗位调版式：

```
index.html?dev=1              # 带切换器，可逐版本预览
index.html?dev=1&lang=en&v=ai # 直接看某个语言 × 版本
```

- `index.html`：默认完整版，含 PDF 下载按钮（按当前语言给对应的完整版 PDF）
- `v/<版本>.<语言>.html`：预生成的静态版本页（**内部用**，供我自己分发/打印，不含切换控件）

`pnpm verify:clean` 守住两条相反的边界：**语言切换必须可用**（含"点按钮真的会切换"的验证），
**版本名与版本切换必须零泄露**（含 `?lang=en&v=ai` 这类绕过尝试被忽略、URL 被清理）。

### 上线发布范围

| 内容 | 是否发布 |
|---|---|
| `index.html`、`daitonghua.jpg`、`.nojekyll` | ✅ 发布 |
| `dist/resume-full.{zh,en,ru}.pdf`（完整版三语） | ✅ 发布，供访客下载 |
| `v/*.html`（13 个静态裁剪页） | ✅ 发布（内部用，无切换控件，不影响访客） |
| `src/`、`tools/`、`README.md` | ✅ 发布（这套工具本身） |
| **`data/`（数据源）** | ❌ **不发布**（隐私） |
| **`文本编辑.md`（改文案用）** | ❌ **不发布**（隐私） |
| `dist/resume-<裁剪版>.*.pdf` | ❌ 不发布（内部版本） |
| `build-manifest.json`、`dist/pdf-manifest.json` | ❌ 不发布（内部构建信息） |

> ⚠️ **代价（必须知道）**：`data/` 不入库，意味着**换机器或重装后无法重新构建**——
> 网站与 PDF 只能沿用已发布的产物。要恢复可构建状态，需手动把 `data/resume.master.json`
> 与 `文本编辑.md` 拷到新机器（或用其他私有方式备份）。

`pnpm verify:downloads` 核对下载链接对应的文件存在、且**确实会被 git 发布**（本地测试正常、线上 404 是典型坑）。

---

## 校验与防漂移

| 命令 | 检查内容 |
|---|---|
| `pnpm check` | 数据合法（节点 id 唯一、三语字段齐全、版本引用存在、tag 拼写）+ 网页产物与数据哈希是否一致 |
| `pnpm verify` | **PDF 是否与数据同步**（比对 `dist/pdf-manifest.json`）+ 每份 PDF 的页数区间、字体嵌入、ToUnicode 非空、空白页 |
| `pnpm verify:cjk` | **汉字可复制性**：渲染器实际绘制的每个汉字是否都在 ToUnicode 里 |
| `pnpm verify:meta` | 13 份 PDF 元数据是否为干净 ASCII |
| `pnpm verify:artifacts` | 引用可达、无 `undefined` 残留、PDF 与 manifest 双向一致、静态页 lang 属性 |
| `pnpm page-report` | 逐页内容量（发现"一页只放了一行"这类版式问题） |
| `pnpm verify:clean` | **上线洁净性**：语言切换可用；内部版本名/版本切换零泄露 |
| `pnpm verify:downloads` | 下载链接的 PDF 存在且会被 git 发布；内部裁剪版不得发布 |
| `pnpm fit-report [变体] [语言]` | **版面余量**：在内存里跑排版，报出每页实际占用多少 pt、末页溢出多少、哪个节点最占地方。调"压进 2 页"时用它代替反复构建试错 |
| `pnpm verify:live` | 线上 GitHub Pages 是否已是当前仓库内容（推送后运行） |

`build-manifest.json` 记录网页产物的内容哈希；`dist/pdf-manifest.json` 记录 PDF 生成时的数据哈希。

> **为什么专门做"PDF 是否过期"这一条**：PDF 由独立命令 `pnpm pdf` 生成，改数据后忘了重新生成时
> 不会有任何东西报错——`dist/` 里会静默留着上一轮的旧 PDF。
> 本项目因此连续多轮把陈旧产物当交付物"验证"，那些结论全部无效。
> 现在 `pnpm verify` 会直接报"PDF 已过期"并以非 0 退出（该守卫已用"改数据→报警→还原"反向验证过）。


## 部署

推送到 `main` 分支即可，GitHub Pages 直接托管仓库根目录（静态文件，无构建步骤）。
`.nojekyll` 已加入，避免 Pages 的 Jekyll 处理。

---

## 已知取舍

- **页数（实际产出）**：完整版**中/英/俄 各 2 页**（三语同一套 `compactValues`，正文 7.75pt / 行距 11.5pt）；
  AI 芯片版、通信 DPD 版、通用海投版、英文单页版**各 1 页**；无线感知版 2 页。
  英文/俄文比中文长：同样内容分别多占约 50pt / 40pt，靠 0.958 的字号缩放与 0.91 的间距系数收进 2 页。
- 未做 DOCX（按需求只出 PDF）。
- 未做构建期字体子集化：字体在 PDF 生成时由 pdfkit 子集嵌入，仓库里不存字体文件。

---

## 已经踩过、代价很大的坑
### 0. 构建静默失败 → 连续多轮都在"验证"陈旧产物

`tools/build-pdf.mjs` 原先把排版异常只是 `console.error` 一行然后 `continue`，**不退出**。
配合 `src/pdf.mjs` 里遗留的一处 `variant is not defined`（重构 `layout`/`layoutInner` 时漏改），
导致每一轮"重新生成 PDF"实际都没写成，`dist/` 里一直是旧文件——
而我用 `verify`/`page-report` 反复审计这些陈旧文件，据此得出的结论**全部无效**。

修法两条，缺一不可：
1. 排版失败必须让整个构建以非 0 退出（`build-pdf.mjs` 收集 `failures` 后 `process.exit(1)`）
2. 生成成功时把数据哈希写入 `dist/pdf-manifest.json`，`pnpm verify` 校验其与当前数据是否一致

**教训**：产物型项目的"验证"必须先证明被验证的对象是新的。否则工具越精细，错得越自信。

### 1. 页脚写法会让每份 PDF 多出一张空白页

`doc.text(str, x, y, { width, align })` —— **同时给出显式坐标和 width/align 时，pdfkit 会按 width 重新排版**，
按推算出的行数推进游标，越过页底就 `addPage()`。页脚位于页面下边距之外，于是每写一次页脚就多一张页。
结果：13 份 PDF **全部**多出 1–2 张只有页脚的空白页，完整版被虚报成 6 页。

修法：页脚只给显式 x/y（`footerLine()`），右对齐改为按测得宽度回推起点，绝不传 width/align。
`tools/verify-pdf.mjs` 现在会检测"空白/近乎空白页"（文本指令 ≤ 3 条或内容流 < 900 字节），这类问题不会再静默通过。

### 2. 不要用 pdfjs 的 `getTextContent()` 判断 PDF 文本可提取性

pdfjs-dist 6.x 对 pdfkit 生成的多字体子集 PDF 会把大量汉字吐成空格，但 PDF 内部的 ToUnicode 映射其实是好的。
用它当判据会产生假失败（曾误判 2 份 PDF "缺少内容"）。
`tools/verify-pdf.mjs` 因此改为直接解析 PDF 对象与 CMap 做结构性核实。

另外：`src/pdf.mjs` 的 `drawLines()` 里**传了显式 x/y 就绝不能再传 `continued: true`**，
两者混用会让 PDFKit 的文本矩阵与 ToUnicode 偏移错位，导致"看得见但提取不出来"（ATS 会整段丢内容）。
同理，按字体切 run 时缓冲区必须绑定字体键，否则 `"AI "` 会和后面的汉字合成一个 Arial run——
Arial 没有 CJK 字形，汉字会被渲染成空白码。

### 3. pdfkit 写非 ASCII 的 PDF 元数据会静默写坏

`doc.info.Title` 传中文时，pdfkit 把值按 UTF-16BE 字节塞进 PDF 字面串，部分字符的字节与字面串的
定界/转义冲突，元数据被写成错误内容且**不报错**。实测：

```
设置 "戴瞳华（你好）"  → 读出 "戴瞳华｜扏恙緿屴"
设置 "戴瞳华，测试"    → 读出 "戴瞳华｜晭䮋"
设置 "戴瞳华「测试」"  → 读出 "戴瞳华ぜ晭䮋"
```

坏字符包括 `( ) （ ） ｜ ， 「 」 《`，而 `| · — – 。 、 ： ／ “ ” ；` 是好的——**按字节或按字符都无法可靠预判**
（`'｜'` = `FF 5C`，含 `0x5C`；但 `'用'` = `75 28` 含 `0x28` 却是好的）。

结论：`tools/build-pdf.mjs` 的 `asciiMeta()` 把元数据限制为 ASCII，`pnpm verify:meta` 守住这条线。
**元数据只影响阅读器标题栏与归档归类，简历正文完全不受影响**（正文走字体子集嵌入，不经过字面串）。

### 4. PowerShell 写文件会带 BOM，`JSON.parse` 会直接报错
在 Windows PowerShell 5.1 里用 `Set-Content -Encoding UTF8` 写 `data/resume.master.json`，**必然写入 BOM**（`EF BB BF`）。
`JSON.parse` 遇到 BOM 会抛 `Unexpected token ''`，构建失败；更糟的是**产物可能仍是旧数据**，
看起来"构建成功"其实没生效（本项目因此白跑过一轮）。

改数据请用编辑工具直接改；若必须用脚本写，务必用无 BOM 编码：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

或直接用 node 的 `fs.writeFileSync(path, text, "utf8")`（node 不写 BOM）。
---

## 另外两个代价很大的坑

### 5. 导航滚动高亮：`href.slice(3)` 把锚点 id 拼错，高亮永远停在第一项

`href` 形如 `#sec-skills`，去掉 `#` 才是锚点 id `sec-skills`。
代码里写成 `'sec' + href.slice(3)`（去掉 `#se`），拼出来是 `secc-skills`，
`getElementById()` 恒为 `null` → 每个板块都被 `continue` 跳过 →
最后走 `return best || links[0]` 的兜底分支，**无论滚到哪儿都高亮第一项**。

这个 bug 之所以活了很久：`tools/verify-clean.mjs` 的 DOM 桩对**任何** id 都 `mk()` 出一个新元素，
于是 `getElementById('secc-skills')` 也返回一个 `rect.top = 0` 的假元素并"命中"，
探针读到的是桩的行为、不是页面的行为。修桩（未知 id 返回 `null`，与浏览器一致）后立刻现形。
现在 `verify:clean` 有两道守卫：静态断言"锚点 id 由 `href.slice(1)` 推导"，
行为断言"7 个滚动位置各自高亮正确的栏目"。

### 6. 课程数据按语言存三份副本 → 总名串语言、导出漏字段

原来 `items` 是 `{zh:[…], en:[…], ru:[…]}` 三份互为副本的数组，每份里的 `name` 是
`{zh,en,ru}` 对象，靠"哪份在最前"决定用哪个语言——实测 `items.zh[0].name` 只有中文名、
`items.en[0].name` 只有英文名。结果：**英文/俄文页面上"数学分析"显示成中文**，
用户看到的正是"课程总名和分名区分不出来"。

已改成单一数组 `items: [{ name:{zh,en,ru}, list:{zh:[],en:[],ru:[]} }]`：
总名走 `pick(name, lang)`、分名走 `list[lang]`，语言必然同源。
顺带修掉了第二个后果——`export-text.mjs` 之前没有 courses 分支，
课程名与课程列表**根本不在 `文本编辑.md` 里**，人工改不到；
`import-text.mjs` 的"未覆盖字段"检查会因此在写盘前拒绝，
所以那 27 个漏掉的字段是"改文案功能直接不可用"，不是"少显示一点"。

守卫：`pnpm validate`（现在会明确报"必须是数组（单一结构）"）+
`pnpm text:check`（数据里每个文本叶子都必须被 md 覆盖）。

---

## 已验证：PDF 里中文可以正确复制

这条曾经是最大风险，现已查清并修复。

**缺陷**：`src/pdf.mjs` 的 `PICK()` 里写成了 `if (isCJK(key))` ——
`isCJK()` 判断的是"单个字符是否为汉字"，而传进来的 `key` 是字体族键字符串 `"cjk"`，
对三字母字符串恒为 `false`。后果：**所有汉字都被交给 Arial 渲染**（Arial 无 CJK 字形），
PDF 能正常打开、版式看着也对，但 ToUnicode 里只声明了 52 个汉字（应当 300+），
**中文完全不可复制、ATS 读不到任何中文内容**。

**发现方式**：不解析 CMap 语法（我在这上面连续写错过 4 次），而是直接扫描 PDF 里的
4 位十六进制 token，统计落在汉字/标点区间的码点个数——`52` 这个数字与简历里数百个汉字的差距
一眼可见。

**修复后**（`key === "cjk"`）：

| 版本 | 修复前声明汉字 | 修复后 |
|---|---|---|
| full/zh | 52 | 427 个全部可复制 |
| ai/zh · dpd/zh | 52 | 241 个全部可复制 |
| sensing/zh | 52 | 336 个全部可复制 |
| general/zh | 52 | 218 个全部可复制 |

**守卫**：`pnpm verify:cjk` 会逐版本核对"渲染器实际绘制的每个汉字是否都在 ToUnicode 里"。
期望值取自布局层在绘制时报告的文本（`doc.__onText`），**不是**从数据结构推测哪些字段会被渲染——
后者会把 `note` 这类不渲染的字段算进来，本项目因此误报过 19 个汉字缺失。

> 附带发现：修复后中文 PDF 从 60 KB 涨到 100–223 KB。之前的小体积正是因为**大部分汉字没有被渲染**。

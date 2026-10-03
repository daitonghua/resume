// 页面组装：动态主页（内嵌全量数据 + 客户端按版本裁剪）与静态版本页（终态 HTML）
import { baseCss } from "./styles.mjs";
import {
  SECTIONS, LANG_LABEL, LANG_SHORT, LANG_THEME,
  selectNodes, visibleSections, sectionOf, renderBody, renderFooter,
} from "./render.mjs";

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** 构建客户端渲染载荷：为每个版本 × 每种语言预先算好"要显示哪些节点、哪些板块" */
export function buildPayload(data) {
  const out = { sections: {}, variants: {} };
  for (const sec of SECTIONS) {
    out.sections[sec] = {};
    for (const lang of Object.keys(LANG_LABEL)) out.sections[sec][lang] = data.sections[sec].title[lang] ?? sec;
  }
  for (const [key, variant] of Object.entries(data.variants)) {
    const langs = variant.langs;
    const entry = {
      label: variant.label,
      targets: variant.targets ?? null,
      isFull: !!variant.isFull,
      note: variant.note ?? null,
      langs,
      byLang: {},
    };
    for (const lang of langs) {
      const nodes = selectNodes(data, key, lang);
      const secs = visibleSections(nodes, variant, data);
      entry.byLang[lang] = {
        // 只取 id，客户端用它从 nodes 里取；顺序即排序结果
        order: nodes.map((n) => n.id),
        secs,
      };
    }
    out.variants[key] = entry;
  }
  return out;
}

function htmlShell({ lang, title, extraCss = "", bodyAttrs = "", content }) {
  return `<!DOCTYPE html>
<html lang="${lang === "zh" ? "zh-CN" : lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${LANG_THEME[lang]}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(title)}">
<style>${baseCss}${extraCss}</style>
</head>
<body${bodyAttrs}>
${content}
</body>
</html>
`;
}

/* ======================= 动态主页 ======================= */

export function renderDynamic(data, payload, { contentHash, variants }) {
  const variantOptions = variants
    .map((k) => `<option value="${k}">${esc(data.variants[k].label.zh)} / ${esc(data.variants[k].label.en)}</option>`)
    .join("");

  // 顶栏分两层可见性：
  //   · 语言切换 + 栏目导航 —— **上线对访客可见**，是简历的正常功能；
  //   · 版本切换、版本目标提示 —— 只在 ?dev=1 时出现，属内部信息（"AI 芯片量化版"这类不对外）。
  // 非 dev 时 URL 只同步 ?lang=，不写入任何内部版本参数。
  const content = `<div class="bar" id="bar" hidden>
  <div class="bar-in">
    <div class="bar-group" id="langGroup">
      <div class="seg" id="langSeg">
        <button data-lang="zh">中文</button>
        <button data-lang="en">English</button>
        <button data-lang="ru">Русский</button>
      </div>
    </div>
    <div class="bar-sep" aria-hidden="true"></div>
    <nav class="bar-nav" id="sectionNav" aria-label="栏目导航"></nav>
    <div class="bar-right">
      <div class="bar-group" id="verGroup" hidden>
        <select id="variantSel" title="Version">${variantOptions}</select>
      </div>
      <span class="variant-note" id="variantNote"></span>
      <button class="btn-print" id="printBtn">打印 / 存为 PDF</button>
    </div>
  </div>
</div>
<main class="wrap" id="doc">
  <div id="docBody"></div>
  <div id="docFoot"></div>
  <div id="docDownload" class="dl-wrap"></div>
</main>
<script id="resume-data" type="application/json">${JSON.stringify({ nodes: data.nodes, payload }).replace(/</g, "\\u003c")}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById('resume-data').textContent);
  var lang = 'zh', variant = 'full';
  var q = new URLSearchParams(location.search);
  // DEV 模式：?dev=1 时额外显示"版本"切换与版本目标提示（内部信息）。
  // 语言切换对所有访客可见，不受 DEV 限制。
  var DEV = q.get('dev') === '1';
  document.getElementById('bar').hidden = false;
  if (DEV) document.getElementById('verGroup').hidden = false;
  // 非 dev 时忽略版本参数，保证线上永远是完整版；语言参数则正常生效
  var wantLang = q.get('lang');
  if (wantLang && D.payload.variants.full.langs.indexOf(wantLang) >= 0) lang = wantLang;
  if (DEV && q.get('v') && D.payload.variants[q.get('v')]) variant = q.get('v');

  var TM = ${JSON.stringify(LANG_THEME)};

  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function rich(s){return esc(s).replace(/&lt;(\\/?)(strong|em|b|i)&gt;/g,'<$1$2>')
    .replace(/&lt;a href=&quot;([^&]*)&quot;&gt;/g,'<a href="$1" target="_blank" rel="noopener">')
    .replace(/&lt;\\/a&gt;/g,'</a>');}
  function pick(v){return (v && typeof v === 'object') ? v[lang] : v;}

  /* --- 与 src/render.mjs 同构的渲染器（同一份数据、同一套规则） --- */
  var R = {
    bullet: function(n){ return '<ul class="bul'+(n.core?' core':'')+'"><li>'+rich(pick(n.text))+'</li></ul>'; },
    skills: function(n,v){
      return n.groups.filter(function(g){
        return keep(g, v, 1);
      }).map(function(g){
        var chips = g.items.map(function(it){
          var d='';for(var i=1;i<=5;i++) d+='<i class="'+(i<=it.level?'f':'')+'"></i>';
          var note = it.note ? '<span class="note">'+esc(pick(it.note))+'</span>' : '';
          return '<span class="chip"><span>'+esc(pick(it.name))+'</span><span class="dots">'+d+'</span>'+note+'</span>';
        }).join('');
        return '<div class="skill-group"><div class="skill-area">'+esc(pick(g.area))+'</div><div class="skill-items">'+chips+'</div></div>';
      }).join('');
    },
    job: function(n,v){
      var link = n.link ? ' · <a class="link-inline" href="'+esc(n.link.href)+'" target="_blank" rel="noopener">'+esc(pick(n.link.label))+'</a>' : '';
      var blocks = (n.blocks||[]).filter(function(b){ return keep(b, v, n.level); }).map(function(b){
        var h = b.heading ? '<div class="block-h">'+rich(pick(b.heading))+'</div>' : '';
        var bs = (b.bullets||[]).filter(function(x){ return keep(x, v, n.level); });
        var l = bs.length ? '<ul class="bul">'+bs.map(function(x){return '<li>'+rich(pick(x.text))+'</li>';}).join('')+'</ul>' : '';
        return (h||l) ? '<div class="block">'+h+l+'</div>' : '';
      }).join('');
      var aw = n.awards ? '<div class="award"><b>Awards:</b> '+esc(pick(n.awards))+'</div>' : '';
      return '<div class="entry">'+head(pick(n.title),pick(n.date))+'<div class="org">'+esc(pick(n.org))+link+'</div>'+blocks+aw+'</div>';
    },
    research: function(n,v){
      var blocks = (n.blocks||[]).map(function(b){
        var bs = (b.bullets||[]).filter(function(x){ return keep(x, v, n.level); });
        return bs.length ? '<div class="block"><ul class="bul">'+bs.map(function(x){return '<li>'+rich(pick(x.text))+'</li>';}).join('')+'</ul></div>' : '';
      }).join('');
      return '<div class="entry">'+head(pick(n.title),pick(n.date))+'<div class="org">'+esc(pick(n.org))+'</div>'+blocks+'</div>';
    },
    edu: function(n){
      var f='';
      // 专业与 GPA 同行（与 PDF 渲染保持一致）
      var ml=[pick(n.major), n.gpa ? ('GPA '+n.gpa) : null].filter(Boolean).join(' · ');
      if(ml) f+='<div class="fact">'+esc(ml)+'</div>';
      if(n.thesis) f+='<div class="fact">'+esc(pick(n.thesis))+'</div>';
      // 导师 / 联合培养项目：放在奖学金之前
      if(n.advisor) f+='<div class="fact">'+esc(pick(n.advisor))+'</div>';
      if(n.program) f+='<div class="fact">'+esc(pick(n.program))+'</div>';
      if(n.scholarship) f+='<div class="fact">'+esc(pick(n.scholarship))+'</div>';
      return '<div class="entry">'+head(pick(n.degree),pick(n.date))+'<div class="org">'+esc(pick(n.school))+'</div>'+f+'</div>';
    },
    courses: function(n){
      // 两级：总名成行加粗，分名缩进（与 render.mjs / pdf.mjs 保持同一结构）
      var groups = pick(n.items) || [];
      var body = groups.map(function(grp){
        var list = (pick(grp.list) || []).map(esc).join(' · ');
        return '<div class="course-group"><div class="course-name">'+esc(pick(grp.name))+
               '</div><div class="course-list">'+list+'</div></div>';
      }).join('');
      return '<details class="courses"><summary>'+esc(pick(n.title))+'</summary><div class="body">'+body+'</div></details>';
    },
    competition: function(n){
      return '<div class="comp-item"><div class="n">'+rich(pick(n.name))+'<span class="yr">'+esc(pick(n.date)||'')+'</span></div><div class="dt">'+rich(pick(n.detail))+'</div></div>';
    },
    pubList: function(n,v){
      var items=(n.items||[]).filter(function(x){ return keep(x, v, n.level); });
      if(!items.length) return '';
      return '<div class="pub-kind">'+esc(pick(n.kind))+'</div><ol class="pubs">'+items.map(function(x){return '<li>'+rich(pick(x.text))+'</li>';}).join('')+'</ol>';
    }
  };
  function head(t,d){ return '<div class="entry-head"><div class="t">'+esc(t)+'</div><div class="d">'+esc(d)+'</div></div>'; }
  function keep(item, v, base){
    var max = v.maxLevel || 3;
    if(item.tags && item.tags.some(function(t){return (v.dropTags||[]).indexOf(t)>=0;})) return false;
    var ka = v.keepTagsAny;
    if(ka && ka.length && item.tags && !item.tags.some(function(t){return ka.indexOf(t)>=0;})) return false;
    return ((item.level||base||1) <= max);
  }
  var SECOF = {};
  Object.keys(D.nodes).forEach(function(id){
    var t = D.nodes[id].type;
    SECOF[id] = t==='bullet'?'competency':
      t==='skills'?'skills': t==='job'?'experience': t==='research'?'research':
      (t==='edu'||t==='courses')?'education': t==='competition'?'competition': t==='pubList'?'publication':null;
  });

  function header(){
    var p = ${JSON.stringify(data.profile)};
    var ic = {
      phone:'<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
      mail:'<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>',
      site:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>'
    };
    var meta = p.links.map(function(l){
      return '<span>'+(ic[l.kind]||ic.site)+'<a href="'+esc(l.href)+'">'+esc(pick(l.label))+'</a></span>';
    }).join('');
    // 判取值后是否为空（location 可能是 {zh:'',...} 这种存在但为空的对象）
    var locText = p.location ? pick(p.location) : '';
    var loc = locText ? '<span>'+ic.site+'<span>'+esc(locText)+'</span></span>' : '';
    return '<header class="hdr"><div class="photo"><img src="daitonghua.jpg" alt="'+esc(pick(p.name))+'"></div>'+
      '<div class="hdr-info"><h1>'+esc(pick(p.name))+'</h1><div class="role">'+esc(pick(p.title))+'</div>'+
      '<div class="meta">'+meta+loc+'</div></div></header>';
  }

  function render(){
    var V = D.payload.variants[variant];
    // 先按当前版本可用语言解析出真正生效的语言，否则 ?lang=zh&v=en-1p 会取到空切片
    if(!V.byLang[lang]) lang = V.langs[0];
    var slice = V.byLang[lang];
    document.documentElement.style.setProperty('--accent', TM[lang] || '#2563eb');
    var vv = ${JSON.stringify(data.variants)}[variant];

    var byId = {};
    slice.order.forEach(function(id){ byId[id] = D.nodes[id]; });
    var html = header();
    var navLinks = [];
    slice.secs.forEach(function(sec){
      var ids = slice.order.filter(function(id){ return SECOF[id] === sec; });
      var inner = ids.map(function(id){ return R[D.nodes[id].type](D.nodes[id], vv); }).filter(function(h){return h && h.trim();}).join('\\n');
      if(!inner.trim()) return;
      var t = D.payload.sections[sec][lang] || sec;
      // 锚点 id 统一加 sec- 前缀：避免与其它元素 id 冲突；导航据此跳转
      html += '<section class="section" id="sec-'+sec+'" data-section="'+sec+'"><h2>'+esc(t)+'</h2>'+inner+'</section>';
      navLinks.push('<a href="#sec-'+sec+'" data-nav="'+sec+'">'+esc(t)+'</a>');
    });
    document.getElementById('docBody').innerHTML = html;
    // 栏目导航：按当前语言与版本的板块列表生成，跟随语言/版本变化
    document.getElementById('sectionNav').innerHTML = navLinks.join('');
    // 切换语言/版本后重新计算当前所在栏目高亮
    window.__syncNav && window.__syncNav();
    // PDF 下载入口：只给当前语言的完整版（每个语言一份，是同一份简历的 PDF）。
    // 裁剪版 PDF 不发布——那是我按岗位裁剪用的内部版本。
    var pdfName = { zh: '简历-完整版-中文.pdf', en: 'Resume-Full-English.pdf', ru: 'Резюме-полное-русский.pdf' }[lang];
    var pdfSign = { zh: '下载 PDF 简历', en: 'Download PDF resume', ru: 'Скачать резюме в PDF' }[lang];
    if (pdfName) {
      document.getElementById('docDownload').innerHTML =
        '<a class="dl" href="dist/resume-full.' + lang + '.pdf" download="' + esc(pdfName) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>' +
        esc(pdfSign) + '</a>';
    }
    var up = {zh:'更新于 ',en:'Updated ',ru:'Обновлено '}[lang] + ${JSON.stringify(data.meta.updated)};
    // 页脚：默认（上线）只显示更新日期，**不显示内部版本名**（如"AI 芯片量化版"）。
    // 只有 ?dev=1 时才把版本名带上，方便我自己区分。
    var footLeft = DEV ? esc(pick(D.payload.variants[variant].label)||'') : '';
    document.getElementById('docFoot').innerHTML = '<footer class="footer"><span>'+footLeft+'</span><span>'+esc(up)+'</span></footer>';

    // 语言按钮的高亮/禁用：对所有访客都要更新（语言切换是上线功能）。
    // 非 dev 时版本固定为 full，其 langs 是 zh/en/ru，三语都可选。
    document.querySelectorAll('#langSeg button').forEach(function(b){
      var ok = D.payload.variants[variant].langs.indexOf(b.dataset.lang) >= 0;
      b.disabled = !ok; b.style.opacity = ok ? 1 : .35;
      b.classList.toggle('on', b.dataset.lang === lang);
    });
    if (DEV) {
      document.getElementById('variantSel').value = variant;
      var tgt = D.payload.variants[variant].targets;
      document.getElementById('variantNote').innerHTML = tgt ? ('<b>'+(lang==='zh'?'目标':'Target')+'</b> '+esc(pick(tgt))) : '';
      // URL 只在 dev 下带 dev/v 参数；这类内部参数不该出现在访客地址栏
      var u = new URL(location.href); u.searchParams.set('dev','1'); u.searchParams.set('lang',lang); u.searchParams.set('v',variant);
      history.replaceState(null,'',u);
    } else {
      // 上线：只同步语言参数（可分享"英文版直链"），不写入任何内部版本参数
      var u2 = new URL(location.href);
      u2.searchParams.delete('dev'); u2.searchParams.delete('v');
      if (lang === 'zh') u2.searchParams.delete('lang'); else u2.searchParams.set('lang', lang);
      history.replaceState(null,'',u2);
    }
  }

  document.getElementById('langSeg').addEventListener('click', function(e){
    if(e.target.tagName === 'BUTTON' && !e.target.disabled){ lang = e.target.dataset.lang; render(); }
  });
  document.getElementById('variantSel').addEventListener('change', function(e){ variant = e.target.value; render(); });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });

  // 滚动高亮 + 点击跳转。
  // 位置判定必须用 getBoundingClientRect()，不能用 offsetTop ——
  // offsetTop 是相对"最近的定位祖先"的偏移，祖先一旦有 position 就会算错，
  // 表现为"滚动时高亮不跟随"（用户报过的问题）。
  (function(){
    var navEl = document.getElementById('sectionNav');
    var activeHref = null;

    function barOffset(){
      var b = document.getElementById('bar');
      return (b ? b.getBoundingClientRect().height : 0) + 10;
    }
    // 返回当前应高亮的 href：所有"已越过吸顶栏"的板块里，位置最靠下的那个
    function currentHref(){
      var links = navEl.querySelectorAll('a');
      if (!links.length) return null;
      var limit = barOffset() + 4;
      var best = null, bestTop = -Infinity;
      for (var i = 0; i < links.length; i++){
        var href = links[i].getAttribute('href') || '';
        // href 形如 "#sec-xxx"：去掉第一个字符 '#' 就得到锚点 id。
        // 曾经写成 slice(3)（去掉 "#se"），拼出来是 "secc-xxx"，getElementById 恒为 null
        // —— 于是每滚到哪儿都只会 fallback 成"高亮第一项"。用户报的"滑动时没有高亮"就是这个。
        var sec = document.getElementById(href.slice(1));
        if (!sec) continue;
        var top = sec.getBoundingClientRect().top;
        if (top <= limit && top > bestTop){ bestTop = top; best = href; }
      }
      return best || (links[0].getAttribute('href') || null);   // 还没滚到第一个板块时高亮首项
    }
    function apply(href){
      if (href === activeHref) return;
      var links = navEl.querySelectorAll('a');
      var hit = null;
      for (var i = 0; i < links.length; i++){
        var on = (links[i].getAttribute('href') === href);
        if (on) hit = links[i];
        if (links[i].classList && links[i].classList.toggle) links[i].classList.toggle('on', on);
        else links[i].className = on ? 'on' : '';
      }
      // 窄屏下整条导航会横向溢出（只能滚），高亮项可能滚出可视区，
      // 看起来就"没有高亮"。仅在这种情况下把它带进视野（避免每次滚动都动页面）。
      if (hit && hit.scrollIntoView && navEl.scrollWidth > navEl.clientWidth + 4) {
        try { hit.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); } catch (_) {}
      }
      activeHref = href;
    }
    function syncNav(){ apply(currentHref()); }

    navEl.addEventListener('click', function(e){
      var a = e.target.closest ? e.target.closest('a') : null;
      if(!a) return;
      var href = a.getAttribute('href') || '';
      var sec = document.getElementById(href.slice(1));
      if(!sec) return;
      e.preventDefault();
      var y = window.pageYOffset + sec.getBoundingClientRect().top - barOffset();
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      history.replaceState(null, '', href);
      apply(href);            // 点击后立即反馈，不等 scroll 事件
    });

    window.__syncNav = syncNav;
    window.__navCurrent = currentHref;   // 供测试直接问"现在该高亮谁"
    window.addEventListener('scroll', syncNav, { passive: true });
    window.addEventListener('resize', syncNav);
    window.addEventListener('hashchange', syncNav);
    syncNav();
  })();

  render();
  if(q.get('print') === '1') setTimeout(function(){ window.print(); }, 350);
})();
</script>`;

  return htmlShell({
    lang: "zh",
    title: `${data.profile.name.zh} · ${data.profile.title.zh}`,
    extraCss: `\n/* build ${contentHash} */\n`,
    content,
  });
}

/* ======================= 静态版本页 ======================= */

export function renderStatic(data, variantKey, lang, { contentHash }) {
  const variant = data.variants[variantKey];
  const body = renderBody(data, variantKey, lang);
  const foot = renderFooter(data, variantKey, lang);
  const content = `<main class="wrap">
${body}
${foot}
</main>`;
  return htmlShell({
    lang,
    title: `${data.profile.name[lang]} · ${variant.label[lang] ?? variant.label.zh}`,
    extraCss: `\n:root{--accent:${LANG_THEME[lang]}}\n/* build ${contentHash} · ${variantKey}/${lang} */\n`,
    bodyAttrs: ' class="static"',
    content,
  });
}

export { LANG_LABEL, LANG_SHORT, LANG_THEME };

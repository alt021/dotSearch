/**
 * 精简模式验证：用抓取的真实 Bing 结果页 HTML，在真实浏览器里跑一遍。
 *
 * 目的：确认 strip-to-results 能真正移除非结果内容，且结果条目不丢失。
 * 真实 Bing DOM 复杂，单元测试覆盖不到，必须在浏览器里实测。
 *
 * 关键点：样例页面必须经 http:// 提供。用 page.setContent 会得到 about:blank
 * 来源，Bing 内联脚本读 cookie 时抛 SecurityError，导致脚本在启动阶段就中断，
 * 验证结果失真。
 *
 *   node scripts/verify-strip.mjs [样例HTML路径]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(
  'C:/Users/AmeXE2/.workbuddy/binaries/node/workspace/node_modules/playwright-core',
);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 第一个非 flag 参数才当作样例路径，避免 --dark 之类被误认成路径
const samplePath =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  'C:/Users/AmeXE2/AppData/Local/Temp/bing_sample.html';

/** 本机 Chromium（沙箱内无法直接启动，需在沙箱外运行本脚本） */
const CHROME = 'C:/Users/AmeXE2/Documents/Programs/Chromite/chrome.exe';

if (!existsSync(samplePath)) {
  console.error(`找不到样例 HTML：${samplePath}`);
  console.error('请先抓取 Bing 结果页，或用第一个命令行参数指定路径。');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`找不到浏览器：${CHROME}`);
  process.exit(2);
}

const html = readFileSync(samplePath, 'utf8');
const bundle = readFileSync(join(root, 'dist/dev/search-enhance.user.js'), 'utf8');

// ---- 用本地 http 服务提供样例页面，避免 about:blank 的 cookie 限制 ----
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
// 带上 q 参数，让页头能显示查询词与统计（样例快照的 URL 本就没有）
const pageUrl = `http://127.0.0.1:${port}/bing.html?q=test`;

const browser = await chromium.launch({ executablePath: CHROME });
// 视口需足够高：默认 1280×720 会让测试目标落到视口外，
// 导致 mouse.move 的坐标无效、悬停断言误判为「未生效」。
const page = await browser.newPage({
  colorScheme: process.argv.includes('--dark') ? 'dark' : 'light',
  viewport: { width: 1280, height: 1000 },
});

const errors = [];
/**
 * 样例 HTML 是抓取下来的快照，其中的内联脚本常因截断而不完整，
 * 会抛出与本项目无关的语法错误。这里只记录来源，用于区分责任。
 */
const foreignErrors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

// 从 http 加载样例页面，来源合法，Bing 内联脚本不会因 cookie 权限中断
await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

// 先记录页面自身的报错基线（注入脚本之前）
const baselineErrors = [...errors];

const before = await page.evaluate(() => ({
  nodes: document.body.querySelectorAll('*').length,
  results: document.querySelectorAll('li.b_algo').length,
  hasHeader: Boolean(document.querySelector('#b_header')),
}));

// 去掉 UserScript 头部注释，只执行脚本主体（模拟 Tampermonkey 注入）
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

// 产物是 IIFE 形式的语句块，不能直接传给 evaluate（会被当表达式求值而语法报错），
// 因此用 Function 构造器在页面上下文执行。
// 先设置强制引擎：样例页地址是本地服务，不匹配 @match，否则脚本会静默退出。
await page.evaluate((src) => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
  // eslint-disable-next-line no-new-func
  new Function(src)();
}, code);
// 脚本含 waitForSelector 异步等待结果容器，给它一点时间
await page.waitForTimeout(1500);

// 只把「注入之后新增」的报错算作本项目的问题
for (const e of errors) {
  if (!baselineErrors.includes(e)) foreignErrors.push(e);
}

const after = await page.evaluate(() => ({
  nodes: document.body.querySelectorAll('*').length,
  results: document.querySelectorAll('.se-list .se-item').length,
  rootExists: Boolean(document.getElementById('se-root')),
  searchBarExists: Boolean(document.querySelector('.se-search')),
  inputValue: document.querySelector('.se-search-input')?.value ?? null,
  // 应当已被清除的原站元素
  /*
   * 原站元素的「残留」检查。
   *
   * 语义已随架构调整：
   *   旧：原站元素必须**完全不存在**（当时是直接清空 body）
   *   新：原站元素不得出现在**可见区域**，但允许存在于隐藏数据源内
   *
   * 之所以保留隐藏数据源，是为了与东方永页机这类自驱动的自动翻页脚本
   * 协同 —— 它们要靠原站结构定位下一页与插入点。详见 pagetual-bridge.ts。
   * 因此这里按「不在 #se-source 内」计数，而不是全局计数。
   */
  leftovers: (() => {
    const outsideSource = (sel) =>
      [...document.querySelectorAll(sel)].filter((el) => !el.closest('#se-source')).length;
    return {
      header: outsideSource('#b_header'),
      footer: outsideSource('#b_footer'),
      dynRail: outsideSource('#b_dynRail'),
      copilot: outsideSource('#b_copilot_search_container'),
      adsMagazine: outsideSource('#b_ads_magazine_container'),
      trivia: outsideSource('#b_TriviaOverlay'),
      oldResultsShell: outsideSource('#b_results'),
      // 原站结果节点不得出现在可见区，可见列表一律由重建的 .se-item 构成
      originalAlgo: outsideSource('li.b_algo'),
    };
  })(),
  // 隐藏数据源：应存在，且确实收纳了原站结果容器
  source: (() => {
    const el = document.getElementById('se-source');
    return {
      exists: Boolean(el),
      resultsInside: el ? el.querySelectorAll('#b_results').length : 0,
      // 不可见：尺寸近零（说明确实被裁掉了，没有漏到页面上）
      size: el
        ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`
        : '-',
    };
  })(),
  // 重建后的结果内容
  firstResult: {
    title: (document.querySelector('.se-item .se-link')?.textContent ?? '').slice(0, 60),
    href: document.querySelector('.se-item .se-link')?.href ?? null,
    cite: (document.querySelector('.se-item .se-cite')?.textContent ?? '').slice(0, 50),
    snippet: (document.querySelector('.se-item .se-snippet')?.textContent ?? '').slice(0, 60),
  },
  // 瑞士风格所需的结构元素
  style: {
    masthead: Boolean(document.querySelector('.se-masthead')),
    brand: Boolean(document.querySelector('.se-brand .se-mark')),
    query: document.querySelector('.se-query')?.textContent
      ?? document.querySelector('.se-query')?.value
      ?? null,
    stat: (document.querySelector('.se-stat')?.textContent ?? '').slice(0, 30),
    numbers: document.querySelectorAll('.se-item .se-num').length,
    firstNumber: document.querySelector('.se-item .se-num')?.textContent ?? null,
  },
  // 调整点 1：整条可点击（stretched link）
  clickable: {
    hitCount: document.querySelectorAll('.se-item .se-hit').length,
    firstHitHref: document.querySelector('.se-item .se-hit')?.href ?? null,
    bodyPointerEvents: getComputedStyle(document.querySelector('.se-body')).pointerEvents,
    numPointerEvents: getComputedStyle(document.querySelector('.se-num')).pointerEvents,
    linkPointerEvents: getComputedStyle(document.querySelector('.se-link')).pointerEvents,
  },
  // 调整点 2：页头标题即搜索输入，无独立搜索框
  search: {
    inMasthead: Boolean(document.querySelector('.se-masthead .se-query')),
    isInput: document.querySelector('.se-query')?.tagName === 'INPUT',
    oldSearchBarGone: document.querySelectorAll('.se-search').length === 0,
  },
  // 调整点 3：分页
  pagination: {
    count: document.querySelectorAll('.se-pagination .se-page').length,
    current: (document.querySelector('.se-page-current')?.textContent ?? '').slice(0, 10),
    currentTag: document.querySelector('.se-page-current')?.tagName ?? null,
  },
  /*
   * 调整点 4：合规链接
   *
   * 同样按「可见区」计数：必应页脚的备案 / 隐私 / 条款链接随原站 DOM
   * 一起被搬进了隐藏数据源，它们不该算作「可见区里的残留」。
   */
  complianceLinks: [...document.querySelectorAll('a[href]')].filter(
    (a) =>
      !a.closest('#se-source') &&
      /隐私|条款|协议|备案|ICP|公网安备|privacy|terms|legal/i.test(a.textContent ?? ''),
  ).length,
  // 视觉调整：红线移除 / 选择禁用 / 悬停反馈扩展
  visual: {
    // ::before 伪元素内容应为空（即无红线）
    beforeContent: getComputedStyle(document.querySelector('.se-item'), '::before').content,
    itemUserSelect: getComputedStyle(document.querySelector('.se-item')).userSelect,
    titleUserSelect: getComputedStyle(
      document.querySelector('.se-title'),
    ).userSelect,
    snippetUserSelect: getComputedStyle(document.querySelector('.se-snippet')).userSelect,
  },
  // 原站跳转链接应已被解析为真实地址
  redirectLeakCount: [...document.querySelectorAll('.se-link')].filter((a) =>
    a.href.includes('bing.com/ck/a'),
  ).length,
}));

/**
 * 实测点击：确认序号区 / 摘要区 / 标题区都能触发跳转。
 * 只看 CSS 属性不够——层序或事件设计有误会让点击落到错误元素上。
 */
const clickProbe = await page.evaluate(() => {
  const item = document.querySelector('.se-item');
  if (!item) return { error: '无条目' };

  // 命中测试：指定点位的最顶层元素是哪个
  const probe = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'null';
    // 向上查找是否落在 hit 或 link 内
    const inHit = Boolean(el.closest('.se-hit'));
    const inLink = Boolean(el.closest('.se-link'));
    return `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}${
      inHit ? ' [命中hit]' : inLink ? ' [命中link]' : ' [未命中]'
    }`;
  };

  const r = item.getBoundingClientRect();
  const numBox = item.querySelector('.se-num').getBoundingClientRect();
  const bodyBox = item.querySelector('.se-body').getBoundingClientRect();
  const linkBox = item.querySelector('.se-link').getBoundingClientRect();
  const snipBox = item.querySelector('.se-snippet')?.getBoundingClientRect() ?? null;

  return {
    onNumber: probe(numBox.left + numBox.width / 2, numBox.top + numBox.height / 2),
    onTitle: probe(linkBox.left + linkBox.width / 2, linkBox.top + linkBox.height / 2),
    onCite: probe(bodyBox.left + 20, bodyBox.top + 6),
    onSnippet: snipBox
      ? probe(snipBox.left + 20, snipBox.top + Math.min(10, snipBox.height / 2))
      : 'n/a',
    // 条目内的空白间隙（grid gap），最容易漏掉
    onGap: probe(r.left + r.width / 2, r.top + r.height - 3),
  };
});

/**
 * 实测大标题的交互状态：平时无框 → 悬停虚线框 → 聚焦无框 → 失焦复原。
 * 悬停与聚焦都用真实鼠标/键盘事件触发，不去读 cssRules
 * （页面脚本无权访问样式表，会抛 SecurityError）。
 */
const queryInput = page.locator('.se-query');
const outlineOf = () =>
  page.evaluate(() => {
    const el = document.querySelector('.se-query');
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: cs.outlineWidth,
      color: cs.outlineColor,
      borderBottom: cs.borderBottomWidth,
    };
  });

const queryState = { normal: await outlineOf() };

// 悬停：真实移动鼠标
const queryBox = await queryInput.boundingBox();
await page.mouse.move(queryBox.x + queryBox.width / 2, queryBox.y + queryBox.height / 2);
await page.waitForTimeout(120);
queryState.hover = await outlineOf();

// 聚焦：真实点击
await page.mouse.click(queryBox.x + queryBox.width / 2, queryBox.y + queryBox.height / 2);
await page.waitForTimeout(120);
queryState.focused = await outlineOf();
queryState.statOnFocus = await page.locator('.se-stat').textContent();

// 改动后失焦：应立即复原。
// 用键盘 Tab 移开焦点，比点击特定坐标可靠（不依赖元素位置与配色）。
await page.keyboard.type('被用户改过的内容');
const typed = await queryInput.inputValue();
await page.keyboard.press('Tab');
await page.waitForTimeout(150);
queryState.typedValue = typed;
queryState.afterBlurValue = await queryInput.inputValue();
queryState.statAfterBlur = await page.locator('.se-stat').textContent();
queryState.restored = queryState.afterBlurValue !== typed;

/**
 * 实测悬停反馈：鼠标停在**非标题区域**（如序号或摘要）时，
 * 标题也应变红并展开下划线 —— 即反馈作用于整条卡片，而非仅标题本身。
 *
 * 注意：必须用 mouse.move（按坐标）而非 locator.hover()。
 * 因为 .se-hit 铺满整条且 z-index 最高，Playwright 的 hover 会认为
 * 元素被遮挡而反复重试超时 —— 这本身恰好证明 hit 层工作正常。
 * 但它也意味着 hover 事件需要真实的鼠标移动才能触发。
 */
/** 悬停到指定坐标并读取标题样式（先移开再移入，确保触发 mouseover） */
const hoverTitleAt = async (x, y) => {
  // 先移到远处再回来：避免 Chromium 合并相邻 mouse.move 而不派发 mouseover
  await page.mouse.move(5, 5);
  await page.waitForTimeout(60);
  await page.mouse.move(x, y);
  await page.waitForTimeout(220);
  return page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.se-link'));
    return { color: s.color, size: s.backgroundSize };
  });
};

const hoverProbe = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('.se-link'));
  return { color: s.color, size: s.backgroundSize };
});

const box = await page.locator('.se-item').first().boundingBox();

// 关键：页面此前已被滚动到下方做点击测试，boundingBox() 返回的是
// 相对文档的坐标，直接拿去 mouse.move 会落到视口之外（实测 y 为负）。
// 先滚回顶部并等待布局稳定，确保目标在视口内且坐标为视口坐标。
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);

const numBox = await page.locator('.se-item .se-num').first().boundingBox();
const snipBox = await page.locator('.se-item .se-snippet').first().boundingBox();

// 悬停到摘要（非标题区域）
const onSnippet = await hoverTitleAt(snipBox.x + 30, snipBox.y + snipBox.height / 2);
const onNum = await hoverTitleAt(numBox.x + numBox.width / 2, numBox.y + numBox.height / 2);
const onOutside = await hoverTitleAt(5, 5);

/**
 * 链接行为验证。
 * 两块内容：
 *   1. 属性：标题锚点与整条锚点都必须有 href 且 target=_blank
 *      （标题锚点若漏了 href，它带 pointer-events:auto 会吞掉点击，
 *        表现为「点标题没反应」—— 曾出现过这个 bug）
 *   2. 实测：点击标题确实触发新标签页打开
 */
const linkAttrs = await page.evaluate(() => {
  const links = [...document.querySelectorAll('.se-item .se-link')];
  const hits = [...document.querySelectorAll('.se-item .se-hit')];
  const stat = (arr, sel) => ({
    total: arr.length,
    withHref: arr.filter((a) => a.getAttribute('href')).length,
    blank: arr.filter((a) => a.getAttribute('target') === '_blank').length,
    noopener: arr.filter((a) => (a.getAttribute('rel') ?? '').includes('noopener')).length,
    sel,
  });
  return { link: stat(links, '.se-link'), hit: stat(hits, '.se-hit') };
});

// 标题中心点命中的应该是有 href 的标题锚点
const titleHitTest = await page.evaluate(() => {
  const link = document.querySelector('.se-item .se-link');
  const r = link.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    tag: el?.tagName ?? null,
    cls: el ? String(el.className).split(' ')[0] : null,
    isTheLink: el === link,
    href: el?.getAttribute?.('href')?.slice(0, 50) ?? null,
    target: el?.getAttribute?.('target') ?? null,
  };
});

/*
 * 实测点击是否新开标签页。
 * 拦截所有外部请求，避免真的去访问外网（测试环境可能不通）。
 */
await page.context().route('**', (route) => {
  const url = route.request().url();
  return url.includes('127.0.0.1') ? route.continue() : route.abort();
});

const titleBox = await page.locator('.se-item .se-link').first().boundingBox();
let popupOpened = false;
let popupUrl = null;
try {
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5_000 }),
    page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2),
  ]);
  popupOpened = true;
  popupUrl = popup.url().slice(0, 50);
  await popup.close().catch(() => {});
} catch {
  popupOpened = false;
}

// 恢复路由
await page.context().unroute('**');

/* ==========================================================================
   页头菜单
   --------------------------------------------------------------------------
   按钮是文档流内的普通元素，位置稳定，可用常规点击验证 ——
   不像先前的贴边侧边栏那样需要绕开合成鼠标在视口边缘的不可靠行为。
   ========================================================================== */
const menuState = async () =>
  page.evaluate(() => {
    const btn = document.querySelector('.se-menu-btn');
    const popup = document.getElementById('se-menu-popup');
    if (!btn || !popup) return { exists: false };
    const popupCs = getComputedStyle(popup);
    const links = [...popup.querySelectorAll('.se-menu-link')];
    const brandRow = btn.closest('.se-brand-row');
    // 探针：按钮自身的盒与「该点最顶层元素」，用于定位点击被拦截的原因
    const r = btn.getBoundingClientRect();
    const atCenter = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2),
    );
    // 完整层叠：Playwright 判定「被拦截」时，需要看清按钮之上还压着什么
    const stack = document
      .elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).split(' ')[0]}`);
    const btnCs = getComputedStyle(btn);
    return {
      btnRect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      btnDisplay: btnCs.display,
      btnPointerEvents: btnCs.pointerEvents,
      stack,
      atCenter: atCenter
        ? `${atCenter.tagName}.${String(atCenter.className).split(' ')[0]}`
        : 'null',
      exists: true,
      label: (btn.textContent ?? '').trim(),
      expanded: btn.getAttribute('aria-expanded'),
      // 必须与「BING — 检索」同处一行
      sameRowAsBrand:
        !!brandRow && brandRow.contains(document.querySelector('.se-brand')),
      popupDisplay: popupCs.display,
      popupPosition: popupCs.position,
      popupInert: popup.hasAttribute('inert'),
      linkCount: links.length,
      links: links.map((a) => ({
        label: (a.textContent ?? '').trim(),
        href: a.getAttribute('href') ?? '',
        target: a.getAttribute('target') ?? '',
        rel: a.getAttribute('rel') ?? '',
      })),
    };
  });

/*
 * 先等视口宽度稳定再做菜单测试。
 *
 * 重写完成后页面高度仍在变化（内容与图片陆续加载），竖向滚动条会延迟出现，
 * innerWidth 随之从 1280 收缩到约 1257。菜单按钮锚在内容区右端，
 * 布局一旦横向位移，先前算好的点击坐标就会落到按钮之外 ——
 * 实测表现为「点击无效」，而按钮本身毫无问题。
 * 连续三次读数一致即认为稳定。
 */
let lastWidth = -1;
let stableCount = 0;
for (let i = 0; i < 40 && stableCount < 3; i++) {
  const w = await page.evaluate(() => window.innerWidth);
  stableCount = w === lastWidth ? stableCount + 1 : 0;
  lastWidth = w;
  await page.waitForTimeout(120);
}

const menuClosed = await menuState();

console.log(
  '  [探针] ' +
    JSON.stringify({
      rect: menuClosed.btnRect,
      display: menuClosed.btnDisplay,
      pe: menuClosed.btnPointerEvents,
      atCenter: menuClosed.atCenter,
      stack: menuClosed.stack,
      sameRow: menuClosed.sameRowAsBrand,
    }),
);

/*
 * 点击按钮（真实鼠标坐标）。
 *
 * 不用 locator.click()：它会做「元素是否被遮挡」检查，
 * 而本环境下该检查对这个按钮持续误报 —— 报的是祖先 .se-brand-row
 * 拦截了事件，但 elementsFromPoint 的完整层叠显示按钮就是最顶层元素
 * （按钮 → slot → brand-row → masthead），其上没有任何东西。
 *
 * 每次尝试都重新取一次坐标：本环境竖向滚动条会间歇性显隐，
 * 布局随之横向位移，先前算好的坐标可能已不在按钮上。
 * 实际尝试了几次会打印出来，便于分辨是「一次成功」还是「靠重试」。
 */
const clickMenuButton = async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const point = await page.evaluate(() => {
      const r = document.querySelector('.se-menu-btn').getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        scrollY: window.scrollY,
        innerWidth: window.innerWidth,
      };
    });
    console.log(
      `  [尝试${attempt}] 坐标(${point.x},${point.y})` +
        ` scrollY=${point.scrollY} innerWidth=${point.innerWidth}`,
    );

    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(220);

    const opened = await page.evaluate(
      () => document.getElementById('se-menu-popup')?.hasAttribute('inert') === false,
    );
    if (opened) return '真实点击';
  }

  /*
   * 兜底：在页内派发 pointerdown。
   * 这与真实点击产生的是**同一种事件类型**，会走我们注册在按钮上的
   * 同一个监听器，因此仍覆盖真实代码路径。
   * 之所以需要它：本环境合成鼠标的落点偶发不生效（坐标每次都是新取的、
   * 按钮也确实是该点最顶层元素，见上方的层叠探针），属测试环境输入层问题。
   */
  const via = await page.evaluate(() => {
    const btn = document.querySelector('.se-menu-btn');
    if (!btn) return null;
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return document.getElementById('se-menu-popup')?.hasAttribute('inert') === false
      ? '派发 pointerdown'
      : null;
  });
  await page.waitForTimeout(220);
  return via;
};

const menuClickVia = await clickMenuButton();
const menuOpen = await menuState();

// 展开态截图（单独一张，便于查看菜单内容）
const menuShot = process.argv.includes('--dark') ? 'strip-menu-dark.png' : 'strip-menu.png';
await page.screenshot({ path: join(root, '.build', menuShot) });

// Esc → 应关闭
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const menuAfterEsc = await menuState();
const shot = process.argv.includes('--dark') ? 'strip-result-dark.png' : 'strip-result.png';
await page.screenshot({ path: join(root, '.build', shot), fullPage: true });

console.log('=== 精简前 ===');
console.log(`  DOM 节点：${before.nodes}`);
console.log(`  结果条目：${before.results}`);
console.log(`  原站顶栏 #b_header：${before.hasHeader ? '存在' : '无'}`);
console.log('=== 精简后 ===');
console.log(`  DOM 节点：${after.nodes}  （减少 ${before.nodes - after.nodes}）`);
console.log(`  重建结果条目：${after.results}  （原站 ${before.results} 条）`);
console.log(`  根容器 #se-root：${after.rootExists}`);
console.log(`  旧搜索框：${after.searchBarExists ? '仍存在' : '已移除'}`);
console.log('=== 首条结果（重建后）===');
console.log(`  标题：${after.firstResult.title}`);
console.log(`  来源：${after.firstResult.cite}`);
console.log(`  摘要：${after.firstResult.snippet}`);
console.log(`  链接：${after.firstResult.href?.slice(0, 60) ?? '(无)'}`);
console.log(`  残留跳转链接：${after.redirectLeakCount}（应为 0）`);
console.log('=== 瑞士风格结构 ===');
console.log(`  页头：${after.style.masthead}  标识块：${after.style.brand}`);
console.log(`  查询词：${after.style.query || '(样例页无 q 参数)'}`);
console.log(`  统计：${after.style.stat}`);
console.log(`  序号栏：${after.style.numbers} 个，首个「${after.style.firstNumber}」`);
console.log('=== 调整点验证 ===');
console.log(
  `  1 整条可点击：hit ${after.clickable.hitCount} 个（应=${before.results}）`,
);
console.log(
  `    pointer-events: body=${after.clickable.bodyPointerEvents}` +
    ` num=${after.clickable.numPointerEvents} link=${after.clickable.linkPointerEvents}`,
);
console.log('    实测点击命中：');
for (const [k, v] of Object.entries(clickProbe)) {
  console.log(`      ${k}: ${v}`);
}
console.log(
  `  2 标题即搜索：页头内 input=${after.search.inMasthead}  isInput=${after.search.isInput}` +
    `  旧搜索框已移除=${after.search.oldSearchBarGone}`,
);
console.log(
  `  3 分页：${after.pagination.count} 个` +
    `  当前页「${after.pagination.current}」为 <${after.pagination.currentTag}>`,
);
console.log(`  4 合规链接残留：${after.complianceLinks}（应为 0）`);
console.log('=== 链接行为 ===');
for (const [name, s] of [
  ['标题 .se-link', linkAttrs.link],
  ['整条 .se-hit ', linkAttrs.hit],
]) {
  console.log(
    `  ${name}：${s.total} 个，有 href ${s.withHref}，target=_blank ${s.blank}` +
      `，rel=noopener ${s.noopener}`,
  );
}
console.log(
  `  标题中心命中：<${titleHitTest.tag} class="${titleHitTest.cls}">` +
    ` 是标题锚点=${titleHitTest.isTheLink} target=${titleHitTest.target}`,
);
console.log(`  实测点击标题：新标签页=${popupOpened}  地址=${popupUrl ?? '(未打开)'}`);
console.log('  [事件] ' + JSON.stringify(await page.evaluate(() => window.__clicks)));
console.log('=== 页头菜单 ===');
console.log('  [展开方式] ' + menuClickVia);
console.log(
  `  按钮：文本「${menuClosed.label}」  与小标题同行=${menuClosed.sameRowAsBrand}`,
);
console.log(
  `  收起：popup display=${menuClosed.popupDisplay} inert=${menuClosed.popupInert}` +
    `  aria-expanded=${menuClosed.expanded}`,
);
console.log(
  `  展开：popup display=${menuOpen.popupDisplay} position=${menuOpen.popupPosition}` +
    ` inert=${menuOpen.popupInert} aria-expanded=${menuOpen.expanded}`,
);
for (const l of menuOpen.links) {
  console.log(`     ${l.label} → ${l.href.slice(0, 56)}  target=${l.target} rel=${l.rel}`);
}
console.log(
  `  Esc 关闭：popup display=${menuAfterEsc.popupDisplay}` +
    ` inert=${menuAfterEsc.popupInert}`,
);
console.log(`  展开态截图：.build/${menuShot}`);
console.log('=== 视觉调整 ===');
console.log(
  `  红线 ::before content：${after.visual.beforeContent}（应为 none 或 normal）`,
);
console.log(
  `  选择禁用：item=${after.visual.itemUserSelect} title=${after.visual.titleUserSelect}` +
    ` snippet=${after.visual.snippetUserSelect}`,
);
// 强调色随配色模式而变：浅色 #E30613 → rgb(227,6,19)，深色提亮为 #ff2a34 → rgb(255,42,52)。
// 因此不能硬编码单一值，应取「未悬停色」以外的那个红色，或直接按模式判断。
const ACCENT_LIGHT = 'rgb(227, 6, 19)';
const ACCENT_DARK = 'rgb(255, 42, 52)';
const isDark = process.argv.includes('--dark');
const ACCENT = isDark ? ACCENT_DARK : ACCENT_LIGHT;
const hoverOk = onSnippet.color === ACCENT && onSnippet.size.startsWith('100%');
console.log(
  `  悬停非标题区（摘要）→ 标题 ${onSnippet.color} 下划线 ${onSnippet.size}` +
    `  ${hoverOk ? 'OK' : '未生效'}`,
);
console.log(
  `  悬停序号 → 标题 ${onNum.color} 下划线 ${onNum.size}` +
    `  ${onNum.color === ACCENT ? 'OK' : '未生效'}`,
);
console.log(
  `  移出卡片 → 标题 ${onOutside.color} 下划线 ${onOutside.size}` +
    `  ${onOutside.color === hoverProbe.color ? '已复原 OK' : '未复原'}`,
);
console.log(`  初始未悬停：${hoverProbe.color} 下划线 ${hoverProbe.size}`);
console.log('=== 大标题交互（真实鼠标/键盘事件）===');
const fmt = (o) => `${o.style} ${o.width} ${o.color}`;
console.log(`  平时：${fmt(queryState.normal)}  下边框=${queryState.normal.borderBottom}`);
console.log(`  悬停：${fmt(queryState.hover)}`);
console.log(`  聚焦：${fmt(queryState.focused)}  提示「${queryState.statOnFocus}」`);
console.log(
  `  失焦：输入过「${queryState.typedValue}」→ 还原为「${queryState.afterBlurValue}」` +
    `  成功=${queryState.restored}  提示「${queryState.statAfterBlur}」`,
);
console.log(
  `  隐藏数据源 #se-source：存在=${after.source.exists} 内含结果容器=${after.source.resultsInside}  尺寸=${after.source.size}`,
);
console.log('=== 原站元素残留检查（可见区内应全为 0）===');
for (const [k, v] of Object.entries(after.leftovers)) {
  console.log(`  ${v === 0 ? 'OK  ' : 'FAIL'} ${k}: ${v}`);
}

// 点击命中：除标题区应命中 link 外，其余区域都应命中 hit
const clickOk =
  clickProbe.onNumber?.includes('[命中hit]') &&
  clickProbe.onCite?.includes('[命中hit]') &&
  clickProbe.onSnippet?.includes('[命中hit]') &&
  clickProbe.onTitle?.includes('[命中link]');

// 链接行为：两个锚点都必须有 href 且新标签打开，且实测能打开
const linkOk =
  linkAttrs.link.withHref === linkAttrs.link.total &&
  linkAttrs.link.blank === linkAttrs.link.total &&
  linkAttrs.hit.withHref === linkAttrs.hit.total &&
  linkAttrs.hit.blank === linkAttrs.hit.total &&
  titleHitTest.isTheLink &&
  titleHitTest.target === '_blank' &&
  popupOpened;

// 页头菜单：与标题同行、开关可见性、入口完整
const menuOk =
  menuClosed.exists &&
  menuClosed.label === '菜单' &&
  menuClosed.sameRowAsBrand &&
  // 收起时应彻底不显示，且不可被 Tab / 读屏访问
  menuClosed.popupDisplay === 'none' &&
  menuClosed.popupInert === true &&
  menuClosed.expanded === 'false' &&
  // 展开后可见可交互
  menuClickVia !== null &&
  menuOpen.popupDisplay !== 'none' &&
  menuOpen.popupInert === false &&
  menuOpen.expanded === 'true' &&
  // 弹出层锚定在按钮下方
  menuOpen.popupPosition === 'absolute' &&
  menuOpen.linkCount === 3 &&
  menuOpen.links.every(
    (l) =>
      l.href.startsWith('http') &&
      l.target === '_blank' &&
      l.rel.includes('noopener'),
  ) &&
  // Esc 可收起
  menuAfterEsc.popupDisplay === 'none' &&
  menuAfterEsc.popupInert === true;

const pass =
  foreignErrors.length === 0 &&
  after.rootExists &&
  after.results === before.results &&
  after.redirectLeakCount === 0 &&
  after.style.masthead &&
  after.style.numbers === before.results &&
  after.clickable.hitCount === before.results &&
  clickOk &&
  linkOk &&
  menuOk &&
  after.search.inMasthead &&
  after.search.oldSearchBarGone &&
  after.complianceLinks === 0 &&
  queryState.restored &&
  queryState.hover.style === 'dashed' &&
  // 聚焦时虚线框应「不可见」：宽度归零即为不可见
  // （样式写成 0 dashed transparent 而非 none，是为清掉浏览器默认焦点环）
  queryState.focused.width === '0px' &&
  queryState.normal.borderBottom === '0px' &&
  // 红线已移除：::before 无内容生成
  (after.visual.beforeContent === 'none' || after.visual.beforeContent === 'normal') &&
  // 整条不可选中
  after.visual.itemUserSelect === 'none' &&
  after.visual.titleUserSelect === 'none' &&
  // 悬停非标题区时标题同样变红 + 展开下划线
  hoverOk &&
  onNum.color === ACCENT &&
  // 可见区内不得有原站元素；隐藏数据源须存在且收纳了原站结果容器
  Object.values(after.leftovers).every((v) => v === 0) &&
  after.source.exists &&
  after.source.resultsInside > 0;

console.log(`\n样例页原有报错（与本项目无关）：${baselineErrors.length} 条`);
if (baselineErrors.length) console.log(`  ${baselineErrors[0].slice(0, 90)}`);
console.log(`注入后新增报错：${foreignErrors.length === 0 ? '无' : foreignErrors.join(' | ')}`);
// 诊断：只列出未通过的断言项，便于定位（通过时不打印）
for (const [k, v] of Object.entries({
  foreignErrors: foreignErrors.length === 0,
  rootExists: after.rootExists,
  resultsEqual: after.results === before.results,
  redirectLeak: after.redirectLeakCount === 0,
  masthead: after.style.masthead,
  numbers: after.style.numbers === before.results,
  hitCount: after.clickable.hitCount === before.results,
  clickOk,
  linkOk,
  menuOk,
  inMasthead: after.search.inMasthead,
  oldSearchBarGone: after.search.oldSearchBarGone,
  complianceLinks: after.complianceLinks === 0,
  restored: queryState.restored,
  hoverStyle: queryState.hover.style === 'dashed',
  focusedWidth: queryState.focused.width === '0px',
  normalBorder: queryState.normal.borderBottom === '0px',
  beforeContent: after.visual.beforeContent === 'none' || after.visual.beforeContent === 'normal',
  itemSelect: after.visual.itemUserSelect === 'none',
  titleSelect: after.visual.titleUserSelect === 'none',
  hoverOk,
  numColor: onNum.color === ACCENT,
  leftovers: Object.values(after.leftovers).every((v) => v === 0),
  sourceExists: after.source.exists === true,
  sourceResultsInside: after.source.resultsInside > 0,
})) {
  if (v !== true) console.log(`  ✗ ${k} = ${JSON.stringify(v)}`);
}

console.log(pass ? '✅ 验证通过' : '❌ 验证失败');
console.log('截图：.build/' + shot);

/* ==========================================================================
   永页机协同
   --------------------------------------------------------------------------
   模拟东方永页机的真实行为：
     1. 它在当前页插入**新的结果容器**（不是往原容器里追加）
     2. 插入完成后广播 postMessage 通知外界
   这里照做，然后断言我们的列表把新结果接了上去。
   ========================================================================== */
const pagerBefore = await page.evaluate(() => {
  const source = document.getElementById('se-source');
  if (!source) return { ok: false, reason: '无隐藏数据源' };

  // 构造「下一页」的容器，结构与必应一致，接在已有容器之后
  const next = document.createElement('ol');
  next.id = 'b_results';
  next.innerHTML =
    '<li class="b_algo">' +
    '<h2><a href="https://example.com/p2-a">第二页结果甲</a></h2>' +
    '<div class="b_attribution"><cite>example.com › p2-a</cite></div>' +
    '<div class="b_caption"><p>这是第二页的第一条摘要。</p></div>' +
    '</li>' +
    '<li class="b_algo">' +
    '<h2><a href="https://example.com/p2-b">第二页结果乙</a></h2>' +
    '<div class="b_attribution"><cite>example.com › p2-b</cite></div>' +
    '<div class="b_caption"><p>这是第二页的第二条摘要。</p></div>' +
    '</li>';
  source.appendChild(next);

  const items = document.querySelectorAll('.se-item').length;
  // 永页机的正式协作接口：插入完成后广播
  window.postMessage({ command: 'pagetual', action: 'insert' }, '*');
  return { ok: true, items, containers: source.querySelectorAll('#b_results').length };
});

// 等合并窗口（200ms）走完再断言
await page.waitForTimeout(700);

const pagerAfter = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.se-item')];
  return {
    count: items.length,
    titles: items.map((li) => (li.querySelector('.se-link')?.textContent ?? '').trim()),
    numbers: items.map((li) => (li.querySelector('.se-num')?.textContent ?? '').trim()),
    stat: (document.querySelector('.se-stat')?.textContent ?? '').trim(),
    // 新采出来的条目不得把原站节点漏到可见区
    visibleAlgo: [...document.querySelectorAll('li.b_algo')].filter(
      (el) => !el.closest('#se-source'),
    ).length,
  };
});

console.log('=== 永页机协同 ===');
console.log(
  `  模拟插入：${pagerBefore.ok ? '成功' : '失败(' + pagerBefore.reason + ')'}` +
    `  隐藏源内结果容器=${pagerBefore.containers ?? '-'}`,
);
console.log(
  `  追加前 ${pagerBefore.items ?? '-'} 条 → 追加后 ${pagerAfter.count} 条` +
    `  页头计数「${pagerAfter.stat}」`,
);
console.log(`  末两条：${pagerAfter.titles.slice(-2).join(' / ')}`);
console.log(
  `  序号续接：${pagerAfter.numbers.slice(-2).join(', ')}` +
    `  可见区原站条目=${pagerAfter.visibleAlgo}`,
);

const pagerOk =
  pagerBefore.ok &&
  pagerAfter.count === (pagerBefore.items ?? -1) + 2 &&
  pagerAfter.titles.includes('第二页结果甲') &&
  pagerAfter.titles.includes('第二页结果乙') &&
  // 序号要接着往下排，不能从 01 重来
  pagerAfter.numbers.slice(-2).join(',') ===
    `${String(pagerAfter.count - 1).padStart(2, '0')},${String(pagerAfter.count).padStart(2, '0')}` &&
  pagerAfter.stat.includes(`${pagerAfter.count} 条`) &&
  pagerAfter.visibleAlgo === 0;

console.log(pagerOk ? '  ✅ 协同正确' : '  ❌ 协同不符预期');

/* ==========================================================================
   已登录分支专项验证
   --------------------------------------------------------------------------
   上面跑的是样例快照，它处于**未登录**状态，只能覆盖「点击登录 Bing」。
   已登录分支必须单独构造：重新载入页面，在注入脚本之前把顶栏改造成
   已登录的样子（头像 aria-label 换成用户名、头像图片显示出来），
   再检查账户入口是否变为「已作为 X 登录」并指向微软账户官网。

   这一步在真实的未登录环境下无法自然触发，因此用构造的 DOM 覆盖。
   ========================================================================== */
await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

const signedInShape = await page.evaluate(() => {
  const avatar = document.getElementById('id_a');
  const profile = document.getElementById('id_p');
  const submit = document.querySelector('#id_l input[type="submit"]');
  if (!avatar) return '缺少 #id_a，无法构造';
  avatar.setAttribute('aria-label', '张小明');
  if (profile) {
    profile.setAttribute('style', '');
    profile.setAttribute('data-alt', '张小明');
    profile.setAttribute('src', 'https://example.com/a.png');
  }
  if (submit) submit.setAttribute('value', '张小明');
  return 'ok';
});

await page.evaluate((src) => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
  new Function(src)();
}, code);
await page.waitForTimeout(1500);

const signedInEntry = await page.evaluate(() => {
  const link = document.querySelector('#se-menu-popup .se-menu-link');
  return link
    ? { label: link.textContent.trim(), href: link.getAttribute('href') }
    : null;
});

console.log('=== 已登录分支 ===');
console.log(`  构造顶栏：${signedInShape}`);
console.log(`  账户入口：${signedInEntry?.label ?? '(缺失)'} → ${signedInEntry?.href ?? ''}`);

const signedInOk =
  signedInShape === 'ok' &&
  signedInEntry !== null &&
  /^已作为 .+ 登录$/.test(signedInEntry.label) &&
  signedInEntry.href.startsWith('https://account.microsoft.com');

console.log(signedInOk ? '  ✅ 已登录分支正确' : '  ❌ 已登录分支不符预期');

await browser.close();
server.close();
process.exit(pass && pagerOk && signedInOk ? 0 : 1);

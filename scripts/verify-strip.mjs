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
import { launchChromite } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 第一个非 flag 参数才当作样例路径，避免 --dark 之类被误认成路径。
// 默认用本仓库自己的快照（scripts/fetch-sample.mjs 写入此处），
// 而不是某个绝对临时路径 —— 后者换台机器就失效，且失败原因不直观。
const samplePath =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(root, '.build', 'bing-live.html');

if (!existsSync(samplePath)) {
  console.error(`找不到样例 HTML：${samplePath}`);
  console.error('请先抓取 Bing 结果页，或用第一个命令行参数指定路径。');
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

const browser = await launchChromite();
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
   *
   * 顺带记下前几条的内容与所在容器：断言失败时若只说「有 1 条」，
   * 还得再跑一轮才能知道是哪条、残留在哪 —— 直接把线索带上。
   */
  compliance: (() => {
    const hit = [...document.querySelectorAll('a[href]')].filter(
      (a) =>
        // 隐藏数据源里的不算
        !a.closest('#se-source') &&
        // 结果条目里的不算：结果标题同样可能出现「协议」这类词
        // （实测有「…快速理解网络通信协议」，只按词匹配会误伤正经结果）
        !a.closest('.se-item') &&
        /隐私|条款|协议|备案|ICP|公网安备|privacy|terms|legal/i.test(a.textContent ?? ''),
    );
    return {
      count: hit.length,
      samples: hit
        .slice(0, 3)
        .map((a) => `「${(a.textContent ?? '').trim().slice(0, 16)}」@#${a.closest('[id]')?.id ?? '?'}`),
    };
  })(),
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
        tag: a.tagName,
        // <button> 没有 href，getAttribute 返回 null；
        // 保留 null 而不是 ''，好让断言能区分「没有 href」与「href 为空串」
        href: a.getAttribute('href'),
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
console.log(
  `  4 合规链接残留：${after.compliance.count}（应为 0）` +
    (after.compliance.count > 0 ? `  ${after.compliance.samples.join(' ')}` : ''),
);
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
  const dest = l.tag === 'BUTTON' ? '(打开设置浮层)' : l.href.slice(0, 56);
  console.log(
    `     [${l.tag}] ${l.label} → ${dest}` +
      (l.tag === 'A' ? `  target=${l.target} rel=${l.rel}` : ''),
  );
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
  // 共 4 项：本脚本的「结果过滤设置」+ 3 个原站入口替代品
  menuOpen.linkCount === 4 &&
  /*
   * 首个条目是「结果过滤设置」，它是 <button> 而非 <a>：
   * 它不跳转，只打开设置浮层，因此不该有 href / target。
   * 用 href === null 与后面三条的 href.startsWith('http') 区分开 ——
   * 若哪天它被误改成 <a href="javascript:void(0)">，这里会立刻报错。
   */
  menuOpen.links[0]?.label === '结果过滤设置' &&
  menuOpen.links[0]?.tag === 'BUTTON' &&
  menuOpen.links[0]?.href === null &&
  menuOpen.links.slice(1).every(
    (l) =>
      l.tag === 'A' &&
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
  after.compliance.count === 0 &&
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
  complianceLinks: after.compliance.count === 0,
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
   结果过滤
   --------------------------------------------------------------------------
   用户需求原文：
     「用户可以设置多个域名，并选择给对应域名的搜索结果标题前添加
       “已排除”标签或直接隐藏对应项目。隐藏的项目不是直接完全删除该结果，
       而是保留结果序号，并在标题部分灰字显示“该结果已隐藏”，
       用户可以单击该隐藏的结果来让其正常显示，
       被用户激活正常显示后与其他搜索项无任何区别」

   拆成五件事逐一断言（按用户措辞的顺序）：
     1. 菜单里能打开设置浮层，能添加 / 切换 / 删除规则
     2. badge 规则 → 标题前出现「已排除」，结果本身照常可点
     3. hide  规则 → 序号保留、标题区灰字「该结果已隐藏」、不可跳转
     4. 单击隐藏项 → 恢复为正常条目（拿回 href、摘要、样式）
     5. 恢复后与普通条目完全一致（不是「看起来像」，是逐个字段相等）
   另外验证父域匹配（csdn.net 命中 blog.csdn.net）与规则跨刷新持久化。

   样例页里可用的真实域名（见 .build/bing-live.html）：
     blog.csdn.net    2 条
     zhuanlan.zhihu.com / www.zhihu.com
   ========================================================================== */

/** 读一条结果的可观测状态：隐藏与否、标签、序号、链接、摘要、灰度 */
const inspectItems = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.se-item')];
    return items.map((li) => {
      const link = li.querySelector('.se-link');
      const hit = li.querySelector('.se-hit');
      const tag = li.querySelector('.se-tag');
      const snippet = li.querySelector('.se-snippet');
      const body = li.querySelector('.se-body');
      return {
        num: (li.querySelector('.se-num')?.textContent ?? '').trim(),
        hidden: li.classList.contains('se-item-hidden'),
        tagText: tag ? tag.textContent.trim() : null,
        tagClass: tag ? tag.className : null,
        // 标签必须排在标题之前（用户原话「标题前」）。
        // 隐藏态没有标题，此时该字段无意义 —— 隐藏态的判据走 bodyChildren。
        tagBeforeTitle: !!(
          tag &&
          link &&
          tag.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
        title: (link?.textContent ?? '').trim(),
        href: hit?.getAttribute('href') ?? null,
        hasLink: !!link,
        hasCite: !!li.querySelector('.se-cite'),
        hasSnippet: !!snippet,
        /*
         * body 栏的直接子元素类名。
         *
         * 隐藏态的契约是「body 里只剩一个占位」——标题、来源、摘要全部搬走，
         * 因此只能靠这个字段断言，不能再去找 .se-link（它已不在文档里）。
         */
        bodyChildren: body
          ? [...body.children].map((c) => c.className)
          : [],
        // 标题/占位文字的实际计算色，用于确认灰字而不是只看 class
        linkColor: link ? getComputedStyle(link).color : null,
        tagColor: tag ? getComputedStyle(tag).color : null,
        citeColor: li.querySelector('.se-cite')
          ? getComputedStyle(li.querySelector('.se-cite')).color
          : null,
      };
    });
  });

/** 清空规则，供各段落之间复位 */
const clearRulesDirect = () =>
  page.evaluate(() => localStorage.removeItem('search-enhance:filter-rules'));

await clearRulesDirect();

/* ---------- 1. 设置浮层：打开 → 添加 → 切换 → 删除 ---------- */

/*
 * 菜单此刻是收起状态（上面按过 Esc），需要重新展开。
 * 用与前面相同的兜底策略：pointerdown 与真实点击走同一个监听器。
 */
await page.evaluate(() => {
  const btn = document.querySelector('.se-menu-btn');
  btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await page.waitForTimeout(200);

const filterEntryExists = await page.evaluate(
  () => !!document.querySelector('#se-menu-popup .se-menu-filter'),
);

/*
 * 点「结果过滤设置」。
 *
 * 不用 locator.click()：该按钮位于 popup 内，而 popup 的父级
 * .se-brand-row 在本环境被 Playwright 误判为「遮挡」（与菜单按钮同因，
 * 见上文 clickMenuButton 的注释）。直接派发 click ——
 * 我们注册的就是 click 监听器，走的仍是真实代码路径。
 */
const panelOpened = await page.evaluate(() => {
  const btn = document.querySelector('#se-menu-popup .se-menu-filter');
  if (!btn) return false;
  btn.click();
  return !!document.querySelector('.se-filter-panel');
});

await page.waitForTimeout(150);

// 通过面板 UI 添加两条规则（走真实的输入 + 按钮路径）
const added = await page.evaluate(() => {
  const input = document.querySelector('.se-filter-add .se-filter-input');
  const select = document.querySelector('.se-filter-add .se-filter-select');
  const btn = document.querySelector('.se-filter-add .se-filter-add-btn');
  if (!input || !select || !btn) return { ok: false, reason: '缺少新增行控件' };

  const submit = (value, action) => {
    input.value = value;
    select.value = action;
    btn.click();
  };
  // 故意写完整网址，验证规范化（用户很可能直接粘贴地址）
  submit('https://blog.csdn.net/qq_54823875/article/details/119358194', 'hide');
  submit('zhihu.com', 'badge');

  const stored = JSON.parse(localStorage.getItem('search-enhance:filter-rules') ?? '[]');
  const rows = document.querySelectorAll('.se-filter-row').length;
  return { ok: true, stored, rows };
});

// 无效输入应被拒绝（不写存储、给出可见提示）
const invalidRejected = await page.evaluate(() => {
  const before = localStorage.getItem('search-enhance:filter-rules');
  const input = document.querySelector('.se-filter-add .se-filter-input');
  const btn = document.querySelector('.se-filter-add .se-filter-add-btn');
  input.value = '不是域名';
  btn.click();
  const after = localStorage.getItem('search-enhance:filter-rules');
  return {
    unchanged: before === after,
    marked: input.classList.contains('se-filter-input-invalid'),
  };
});

/*
 * 重复添加同域名应「改动作」而非堆两条。
 *
 * 这里故意再写一次三段域名 blog.csdn.net ——
 * 规范化会把它收敛成 csdn.net，与已有规则视为同一条。
 */
const deduped = await page.evaluate(() => {
  const input = document.querySelector('.se-filter-add .se-filter-input');
  const select = document.querySelector('.se-filter-add .se-filter-select');
  const btn = document.querySelector('.se-filter-add .se-filter-add-btn');
  input.value = 'blog.csdn.net';
  select.value = 'hide';
  btn.click();
  return JSON.parse(localStorage.getItem('search-enhance:filter-rules') ?? '[]');
});

// 改 selects 的 action：把 csdn 从 hide 改成 badge
const toggled = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.se-filter-row')];
  // 行里显示的是**规范化后**的域名，所以按 csdn.net 找，不是 blog.csdn.net
  const target = rows.find(
    (r) => r.querySelector('.se-filter-domain')?.value === 'csdn.net',
  );
  const select = target?.querySelector('.se-filter-action');
  if (!select) return null;
  select.value = 'badge';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.parse(localStorage.getItem('search-enhance:filter-rules') ?? '[]');
});

console.log('=== 结果过滤：设置浮层 ===');
console.log(`  菜单入口「结果过滤设置」：${filterEntryExists ? '存在' : '缺失'}`);
console.log(`  点击后浮层打开：${panelOpened}`);
console.log(
  `  通过 UI 添加两条：行数=${added.rows ?? '-'}  存储=${JSON.stringify(added.stored ?? [])}`,
);
console.log(`  无效输入被拒：存储未变=${invalidRejected.unchanged}  标记=${invalidRejected.marked}`);
console.log(`  重复添加同域名：${JSON.stringify(deduped)}`);
console.log(`  切换动作后：${JSON.stringify(toggled ?? [])}`);

const panelOk =
  filterEntryExists &&
  panelOpened &&
  added.ok &&
  added.rows === 2 &&
  // 完整网址按站点归并：blog.csdn.net 收敛为 csdn.net
  added.stored.some((r) => r.domain === 'csdn.net' && r.action === 'hide') &&
  added.stored.some((r) => r.domain === 'zhihu.com' && r.action === 'badge') &&
  invalidRejected.unchanged &&
  invalidRejected.marked &&
  // 去重后仍是两条，且动作被覆盖
  deduped.length === 2 &&
  deduped.find((r) => r.domain === 'csdn.net')?.action === 'hide' &&
  toggled !== null &&
  toggled.find((r) => r.domain === 'csdn.net')?.action === 'badge';

/*
 * 面板保持打开 —— 下面 badge 段落要先断言，再在面板内把两条规则改成 hide。
 * 浮层用 position: fixed 居中，不遮挡结果列表的读取
 * （inspectItems 走的是 DOM 查询，不受遮挡影响）。
 */

/* ---------- 2. badge：「已排除」标签 ---------- */

/*
 * 此刻两条规则都是 badge（csdn 与 zhihu）。
 * csdn 规则写的是 blog.csdn.net，样例里还有 zhuanlan.zhihu.com / www.zhihu.com；
 * 后两者应由 zhihu.com 这条父域规则命中 —— 顺带验证父域匹配。
 */
await page.waitForTimeout(200);
const badgeState = await inspectItems();
const badgeItems = badgeState.filter((i) => i.tagText === '已排除');

console.log('=== 结果过滤：badge（已排除）===');
console.log(`  带「已排除」标签的结果：${badgeItems.length} 条 / 共 ${badgeState.length} 条`);
for (const i of badgeState) {
  console.log(
    `     ${i.num} [${i.tagText ?? '—'}] ${i.title.slice(0, 34)}` +
      `  hidden=${i.hidden} href=${i.href ? '有' : '无'}`,
  );
}

const badgeOk =
  // 至少命中 csdn 2 条 + zhihu 3 条
  badgeItems.length >= 5 &&
  // csdn 与 zhihu 两类都应命中（前者按精确子域，后者按父域）
  badgeItems.some((i) => i.title.includes('CSDN')) &&
  badgeItems.some((i) => i.title.includes('知乎')) &&
  // 标签必须在标题文字之前（compareDocumentPosition 已解析为布尔）
  badgeItems.every((i) => i.tagBeforeTitle) &&
  // badge 只是提示，结果本身完全正常：不隐藏、可跳转、摘要还在
  badgeItems.every((i) => !i.hidden && i.href && i.hasSnippet) &&
  // 未命中的结果一个标签都不该有
  badgeState.filter((i) => i.tagText === null).length > 0 &&
  badgeState.filter((i) => i.tagText === null).every((i) => !i.hidden && i.href);

console.log(badgeOk ? '  ✅ badge 正确' : '  ❌ badge 不符预期');

/* ---------- 3. hide：保留序号 + 灰字「该结果已隐藏」 ---------- */

/*
 * 把两条规则都改成 hide。
 *
 * 这里刻意**通过面板 UI 改**，而不是直接写 storage 再重载：
 * 「改完立刻看到效果」是本功能的承诺，绕开 UI 测不到这条路径。
 * （先前版本直接写 storage 后期望列表自动重建 —— 那是不成立的，
 *   存储变更只由面板的 onApply 回调触发重渲染。）
 * 面板此刻仍开着，逐行改 select 并派发 change 即可。
 */
const switchedToHide = await page.evaluate(() => {
  const seen = [];
  /*
   * 每轮都重新查询行。
   *
   * commit() → render() 会把所有行节点整体重建（textContent = '' 再重画），
   * 因此在循环外缓存 rows 数组是错的：第一轮之后手里的节点已脱离文档，
   * 后续轮次的 change 派发到孤岛上，既不会写存储也不会重渲染。
   * 这是本验证脚本踩过的坑，不是实现的问题 —— 用 while 按域名重取。
   */
  const domains = ['csdn.net', 'zhihu.com'];
  for (const domain of domains) {
    const row = [...document.querySelectorAll('.se-filter-row')].find(
      (r) => r.querySelector('.se-filter-domain')?.value === domain,
    );
    const select = row?.querySelector('.se-filter-action');
    if (!select) continue;
    select.value = 'hide';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    seen.push({
      domain,
      hidden: document.querySelectorAll('.se-item-hidden').length,
    });
  }
  return seen;
});

console.log('  逐行改为 hide 后的即时隐藏数：' + JSON.stringify(switchedToHide));

// 关掉面板再断言（面板会挡住点击坐标）
await page.evaluate(() => document.querySelector('.se-filter-close')?.click());
await page.waitForTimeout(250);

const hideState = await inspectItems();
const hiddenItems = hideState.filter((i) => i.hidden);

console.log('=== 结果过滤：hide（隐藏）===');
console.log(`  隐藏条目：${hiddenItems.length} / ${hideState.length}`);
for (const i of hiddenItems) {
  console.log(
    `     序号「${i.num}」 文字「${i.tagText}」 href=${i.href}` +
      ` body 子元素=[${i.bodyChildren.join(', ')}]`,
  );
}
// 序号保留：把所有序号连起来看是否仍是连续 01..N（说明没有被删掉重排）
const nums = hideState.map((i) => i.num).join(',');
const expectNums = hideState
  .map((_, idx) => String(idx + 1).padStart(2, '0'))
  .join(',');

console.log(`  全部序号：${nums}`);
console.log(`  序号连续（未被删除重排）：${nums === expectNums}`);
console.log(
  `  其余条目序号取到的最大值为隐藏项序号：` +
    `${hiddenItems.every((h) => nums.split(',').includes(h.num))}`,
);

const hideOk =
  // csdn 2 条 + zhihu 3 条 = 5 条
  hiddenItems.length === 5 &&
  // 序号保留：整列序号仍是 01..N 连续，隐藏项没有被摘掉
  nums === expectNums &&
  /*
   * 契约：隐藏项在**链接所在处**只显示一行灰字占位，
   * 标题与描述都不显示。
   * 因此 body 栏里应当只剩这一个子元素 —— 不是「标题变灰」那种残留，
   * 而是真的不再有标题、来源、摘要三个节点。
   */
  hiddenItems.every((i) => i.tagText === '该结果已隐藏') &&
  hiddenItems.every((i) => i.tagClass?.includes('se-tag-hidden')) &&
  hiddenItems.every(
    (i) => i.bodyChildren.length === 1 && i.bodyChildren[0].includes('se-tag-hidden'),
  ) &&
  hiddenItems.every((i) => !i.hasLink && !i.hasCite && !i.hasSnippet) &&
  // 占位文字是灰字：与正文标题色不同
  hiddenItems.every((i) => {
    const normal = hideState.find((n) => !n.hidden);
    return normal ? i.tagColor !== normal.linkColor : true;
  }) &&
  // 未展开前不可跳转：整条链接地址被摘掉
  hiddenItems.every((i) => i.href === null) &&
  // 未命中的条目完全不受影响
  hideState.filter((i) => !i.hidden).every((i) => i.href && i.tagText === null) &&
  // 「改完立即生效」：改第一行后就应有隐藏项出现（csdn 那 2 条）
  switchedToHide.length === 2 &&
  switchedToHide[0].hidden === 2 &&
  switchedToHide[1].hidden === 5;

console.log(hideOk ? '  ✅ hide 正确' : '  ❌ hide 不符预期');

/* ---------- 4. 单击隐藏项 → 恢复正常 ---------- */

const hiddenShot = process.argv.includes('--dark')
  ? 'strip-filter-hidden-dark.png'
  : 'strip-filter-hidden.png';
await page.screenshot({ path: join(root, '.build', hiddenShot), fullPage: true });

/*
 * 单击第一条隐藏项。
 *
 * 用真实鼠标坐标点击（而不是 dispatchEvent）：
 * 「用户单击」是需求里的原话，必须验证合成鼠标能真正落到占位条上 ——
 * 这同时验证了占位条没有被别的元素挡住。
 */
const firstHiddenBox = await page.locator('.se-item-hidden').first().boundingBox();
const hiddenNumBefore = hiddenItems[0]?.num;
const hiddenTitleBefore = hiddenItems[0]?.title;
await page.mouse.click(firstHiddenBox.x + firstHiddenBox.width / 2, firstHiddenBox.y + 20);
await page.waitForTimeout(250);

const afterReveal = await inspectItems();
const revealed = afterReveal.find((i) => i.num === hiddenNumBefore);

console.log('=== 结果过滤：单击解除隐藏 ===');
console.log(
  `  原隐藏项 序号「${hiddenNumBefore}」 「${hiddenTitleBefore?.slice(0, 26)}」` +
    ` → hidden=${revealed?.hidden} 标签=${revealed?.tagText ?? '(无)'}` +
    ` href=${revealed?.href ? '有' : '无'} 摘要=${revealed?.hasSnippet}`,
);
console.log(`  剩余隐藏条目：${afterReveal.filter((i) => i.hidden).length}`);

const revealOk =
  !!revealed &&
  revealed.hidden === false &&
  revealed.tagText === null &&
  typeof revealed.href === 'string' &&
  revealed.href.startsWith('http') &&
  revealed.hasSnippet === true &&
  // 只解除了被点的那一条
  afterReveal.filter((i) => i.hidden).length === hiddenItems.length - 1;

console.log(revealOk ? '  ✅ 单击恢复正常' : '  ❌ 单击恢复正常不符预期');

/* ---------- 5. 恢复后与普通条目逐字段一致 ---------- */

/*
 * 用户原话：「被用户激活正常显示后与其他搜索项无任何区别」。
 * 因此不能只看「看起来正常」，要拿一个从未被隐藏的条目作对照，
 * 逐字段比较结构差异。
 *
 * 先把鼠标移开：上一步的点击让指针停在刚恢复的条目上，
 * 标题正处于悬停态（着色 + 下划线），与未悬停的对照样本比较必然「有差异」。
 * 那是光标位置造成的，不是条目本身的差别。
 */
await page.mouse.move(5, 5);
await page.waitForTimeout(200);
const parity = await page.evaluate((revealedNum) => {
  const pick = (li) => {
    const link = li.querySelector('.se-link');
    const hit = li.querySelector('.se-hit');
    const cs = getComputedStyle(link);
    return {
      classes: [...li.classList].sort().join(' '),
      hasTag: !!li.querySelector('.se-tag'),
      hasSnippet: !!li.querySelector('.se-snippet'),
      linkColor: cs.color,
      linkDecoration: cs.textDecorationLine,
      linkUserSelect: cs.userSelect,
      hitHref: hit?.getAttribute('href') ? 'yes' : null,
      hitTarget: hit?.getAttribute('target') ?? null,
      hitRel: hit?.getAttribute('rel') ?? null,
      hitAriaHidden: hit?.getAttribute('aria-hidden') ?? null,
      hitTabIndex: hit?.getAttribute('tabindex') ?? null,
    };
  };
  const items = [...document.querySelectorAll('.se-item')];
  // 被解除隐藏的那条：按序号定位（序号是稳定的，且正是本功能的保留项）
  const revived = items.find(
    (li) => (li.querySelector('.se-num')?.textContent ?? '').trim() === revealedNum,
  );
  if (!revived) return { ok: false, reason: '未按序号找到刚恢复的条目' };
  if (revived.classList.contains('se-item-hidden')) {
    return { ok: false, reason: '目标条目仍处于隐藏态' };
  }
  /*
   * 对照样本：一条从未命中过规则的条目。
   * 末条最稳妥 —— 样例里靠后的结果都不属于 csdn / zhihu。
   */
  const never = items[items.length - 1];
  if (never === revived) {
    // 万一刚恢复的正好是末条，改用首条从未命中的
    const alt = items.find((li) => !li.classList.contains('se-item-hidden') && !li.querySelector('.se-tag') && li !== revived);
    return alt ? { ok: true, revived: pick(revived), control: pick(alt) } : { ok: false, reason: '无可用对照样本' };
  }
  return { ok: true, revived: pick(revived), control: pick(never) };
}, hiddenNumBefore);

console.log('=== 结果过滤：恢复后与普通条目一致性 ===');
if (parity.ok) {
  for (const k of Object.keys(parity.revived)) {
    const a = parity.revived[k];
    const b = parity.control[k];
    console.log(`     ${a === b ? '一致' : '差异'} ${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
} else {
  console.log(`     无法取到对照样本：${parity.reason ?? '(未知)'}`);
}

const parityOk =
  parity.ok &&
  parity.revived.classes === parity.control.classes &&
  parity.revived.hasTag === false &&
  parity.revived.hasSnippet === parity.control.hasSnippet &&
  parity.revived.linkColor === parity.control.linkColor &&
  parity.revived.linkDecoration === parity.control.linkDecoration &&
  parity.revived.hitHref === parity.control.hitHref &&
  parity.revived.hitTarget === parity.control.hitTarget &&
  parity.revived.hitRel === parity.control.hitRel &&
  parity.revived.hitAriaHidden === parity.control.hitAriaHidden &&
  parity.revived.hitTabIndex === parity.control.hitTabIndex;

console.log(parityOk ? '  ✅ 与普通条目完全一致' : '  ❌ 与普通条目仍有差异');

/* ---------- 6. 规则跨刷新持久化 ---------- */

/*
 * 过滤配置存 localStorage（用户级偏好），换页 / 刷新都应留着。
 * 这里直接重载页面 —— 而重写每次都会重建列表，
 * 因此同时验证了「规则在首次重写时就生效」，而不是等用户再进一次设置。
 */
const persistedBefore = await page.evaluate(() =>
  localStorage.getItem('search-enhance:filter-rules'),
);
await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
await page.evaluate((src) => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
  new Function(src)();
}, code);
await page.waitForTimeout(1500);

const afterReload = await page.evaluate(() => ({
  stored: localStorage.getItem('search-enhance:filter-rules'),
  hidden: document.querySelectorAll('.se-item-hidden').length,
  tagged: document.querySelectorAll('.se-tag-hidden').length,
  total: document.querySelectorAll('.se-item').length,
}));

console.log('=== 结果过滤：跨刷新持久化 ===');
console.log(`  刷新前存储：${persistedBefore}`);
console.log(`  刷新后存储：${afterReload.stored}`);
console.log(
  `  重写后即生效：隐藏 ${afterReload.hidden} 条 / 共 ${afterReload.total} 条` +
    `，灰字标记 ${afterReload.tagged} 个`,
);
const persistOk =
  // 存储内容原样保留（含未改动的行为），说明写的是持久层而非会话层
  persistedBefore === afterReload.stored &&
  persistedBefore !== null &&
  // 规则在「首次重写时」就生效，无需用户再进一次设置
  afterReload.hidden === 5 &&
  afterReload.hidden === afterReload.tagged &&
  afterReload.hidden < afterReload.total;

console.log(persistOk ? '  ✅ 持久化正确' : '  ❌ 持久化不符预期');

// 清掉规则，避免污染后续段落
await clearRulesDirect();

/* ---------- 7. 样式隔离与控件配色 ---------- */

/*
 * 针对一个真实故障补的回归断言：
 *   面板在暗色模式下「大量配色错误」，且下拉框完全没有自定义样式。
 *
 * 两个独立成因，都要测住：
 *   a. 原站样式表从未被禁用。重写只清了原站**内容**，
 *      但 Bing 的 CSS 挂在 <head> 上继续全局生效，
 *      把我们的控件染成了它自己的配色（输入框文字变 #444、边框 #ddd）。
 *   b. 已有规则行的下拉框用 `.se-filter-action`，
 *      而 CSS 只覆盖了 `.se-filter-select` —— 那个下拉框吃的是原生外观，
 *      字体是 Arial、背景是 UA 的白。
 *
 * 配色断言不写死色值，而是与当前主题下的 CSS 变量比对 ——
 * 这样浅色与深色两次运行（verify:strip / verify:strip --dark）都成立。
 */
const styleState = await page.evaluate(() => {
  const css = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // 把 #rrggbb 转成浏览器的 rgb() 形式，便于与 computed 值直接比对
  const toRgb = (hex) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const vars = {
    bg: toRgb(css('--se-bg')),
    fg: toRgb(css('--se-fg')),
    line: toRgb(css('--se-line')),
  };

  /*
   * 先塞一条规则再开面板：`已有规则行` 的下拉框是本次要测的重点之一，
   * 而它只在有规则时才存在（空列表渲染的是「- EMPTY -」占位）。
   * 面板在渲染时读存储，所以必须在点击打开之前写入。
   */
  localStorage.setItem(
    'search-enhance:filter-rules',
    JSON.stringify([{ domain: 'example.com', action: 'badge' }]),
  );
  document.querySelector('.se-menu-btn')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  document.querySelector('#se-menu-popup .se-menu-filter')?.click();

  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor, font: cs.fontFamily, scheme: cs.colorScheme };
  };

  // 统计仍然启用的原站样式表
  let enabledForeign = 0;
  let totalForeign = 0;
  for (const el of document.querySelectorAll('link[rel="stylesheet"], style')) {
    if (el.id === 'search-enhance-styles' || el.id === 'se-rewrite-style') continue;
    totalForeign++;
    if (!el.disabled) enabledForeign++;
  }

  return {
    vars,
    panel: pick('.se-filter-panel'),
    domainInput: pick('.se-filter-domain'),
    rowSelect: pick('.se-filter-action'),
    addSelect: pick('.se-filter-select'),
    removeBtn: pick('.se-filter-remove'),
    enabledForeign,
    totalForeign,
    ownStyleSheet: !!document.getElementById('search-enhance-styles'),
  };
});

console.log('=== 结果过滤：样式隔离与控件配色 ===');
console.log(
  `  原站样式表：共 ${styleState.totalForeign} 个，仍启用 ${styleState.enabledForeign} 个（应为 0）`,
);
console.log(`  本脚本样式表存在：${styleState.ownStyleSheet}`);
for (const [name, el] of [
  ['域名输入框 .se-filter-domain', styleState.domainInput],
  ['已有行下拉 .se-filter-action', styleState.rowSelect],
  ['新增行下拉 .se-filter-select', styleState.addSelect],
]) {
  if (!el) {
    console.log(`  ${name}：(缺失)`);
    continue;
  }
  console.log(
    `  ${name}：bg=${el.bg} color=${el.color} border=${el.border}` +
      ` 字体=${el.font.split(',')[0]} scheme=${el.scheme}`,
  );
}

// 输入类控件：必须用我们自己的三件套（底色 / 文字 / 描边）
const usesOwnPalette = (el) =>
  !!el &&
  el.bg === styleState.vars.bg &&
  el.color === styleState.vars.fg &&
  el.border === styleState.vars.line;

/*
 * 按钮是另一种处理：透明底 + 前景色描边（见 .se-filter-add-btn/.se-filter-remove）。
 * 不套用上面的三件套判据，否则会把正确的样式误判为失败。
 */
const isOutlineButton = (el) =>
  !!el && el.bg === 'rgba(0, 0, 0, 0)' && el.color === styleState.vars.fg && el.border === styleState.vars.fg;

/*
 * 只比对字体栈的**首个**字族。
 * 整串里本来就含 Arial / sans-serif 作为回退（见 base.css 的正文栈），
 * 拿整串去匹配 Arial 会把正确的样式判成失败 —— 初版断言正是这么写错的。
 * 首字族若不是 Helvetica 系，说明控件吃的是 UA/原生的默认字体。
 */
const firstFamily = (el) =>
  (el?.font ?? '').split(',')[0].replace(/["']/g, '').trim();

const stylesOk =
  styleState.ownStyleSheet &&
  // 原站样式表必须全部关掉
  styleState.enabledForeign === 0 &&
  styleState.totalForeign > 0 &&
  // 三种输入控件都要吃我们自己的配色（这正是用户报的两个问题）
  usesOwnPalette(styleState.domainInput) &&
  usesOwnPalette(styleState.rowSelect) &&
  usesOwnPalette(styleState.addSelect) &&
  isOutlineButton(styleState.removeBtn) &&
  /Helvetica/i.test(firstFamily(styleState.rowSelect)) &&
  /Helvetica/i.test(firstFamily(styleState.addSelect));

console.log(stylesOk ? '  ✅ 样式隔离与配色正确' : '  ❌ 样式隔离或配色不符预期');

const filterOk = panelOk && badgeOk && hideOk && revealOk && parityOk && persistOk && stylesOk;
console.log(filterOk ? '✅ 结果过滤整体通过' : '❌ 结果过滤存在失败项');

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
  /*
   * 取账户那条 —— 它是 <a>，而首条「结果过滤设置」是 <button>。
   * 早期版本用 '.se-menu-link' 取首个匹配，加了过滤入口后
   * 拿到的变成了那个按钮（label「结果过滤设置」、无 href），断言随之失败。
   */
  const link = document.querySelector('#se-menu-popup a.se-menu-link');
  const first = document.querySelector('#se-menu-popup .se-menu-link');
  return {
    label: link ? link.textContent.trim() : null,
    href: link?.getAttribute('href') ?? null,
    // 顺带确认过滤入口仍在首位且未串位
    firstTag: first?.tagName ?? null,
    firstLabel: first ? first.textContent.trim() : null,
  };
});

console.log('=== 已登录分支 ===');
console.log(`  构造顶栏：${signedInShape}`);
console.log(`  菜单首项：[${signedInEntry.firstTag}] ${signedInEntry.firstLabel}`);
console.log(`  账户入口：${signedInEntry.label ?? '(缺失)'} → ${signedInEntry.href ?? ''}`);

const signedInOk =
  signedInShape === 'ok' &&
  signedInEntry.firstTag === 'BUTTON' &&
  signedInEntry.firstLabel === '结果过滤设置' &&
  signedInEntry.label !== null &&
  /^已作为 .+ 登录$/.test(signedInEntry.label) &&
  (signedInEntry.href ?? '').startsWith('https://account.microsoft.com');

console.log(signedInOk ? '  ✅ 已登录分支正确' : '  ❌ 已登录分支不符预期');

await browser.close();
server.close();
process.exit(pass && pagerOk && filterOk && signedInOk ? 0 : 1);

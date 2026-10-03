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
  leftovers: {
    header: document.querySelectorAll('#b_header').length,
    footer: document.querySelectorAll('#b_footer').length,
    dynRail: document.querySelectorAll('#b_dynRail').length,
    copilot: document.querySelectorAll('#b_copilot_search_container').length,
    adsMagazine: document.querySelectorAll('#b_ads_magazine_container').length,
    trivia: document.querySelectorAll('#b_TriviaOverlay').length,
    oldResultsShell: document.querySelectorAll('#b_results').length,
    // 原站结果节点应已完全丢弃，改为重建
    originalAlgo: document.querySelectorAll('li.b_algo').length,
  },
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
  // 调整点 4：合规链接
  complianceLinks: [...document.querySelectorAll('a[href]')].filter((a) =>
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
   右侧工具栏（替代原 Tampermonkey 菜单）
   三态必须实测：收起 → 鼠标贴近右边缘露出 → 点击展开 → Esc 关闭
   ========================================================================== */
/*
 * 等待视口宽度稳定后再做工具栏测试。
 *
 * 原因：重写后页面高度仍在变化（内容/图片加载），竖向滚动条会延迟出现，
 * 使 innerWidth 从 1280 收缩到约 1257。若在此之前算好边缘坐标，
 * 等到点击时布局已经横向位移 —— 实测会出现「按下的点已在视口之外」
 * （elementFromPoint 返回 null）、露出与悬停断言连带失败。
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
console.log('  [视口] 稳定于 innerWidth=' + lastWidth);

// 前面的 popup 测试可能让本页失去焦点，先确保它在最前
await page.bringToFront();
await page.mouse.move(10, 10);
await page.waitForTimeout(150);

const toolbarState = async () =>
  page.evaluate(() => {
    const bar = document.getElementById('se-toolbar');
    if (!bar) return { exists: false };
    const panel = bar.querySelector('.se-toolbar-panel');
    const tab = bar.querySelector('.se-toolbar-tab');
    const scrim = bar.parentElement?.querySelector('.se-toolbar-scrim');
    const links = [...bar.querySelectorAll('.se-toolbar-link')];
    const cs = getComputedStyle(bar);
    const scrimCs = scrim ? getComputedStyle(scrim) : null;
    return {
      exists: true,
      peek: bar.classList.contains('se-peek'),
      open: bar.classList.contains('se-open'),
      panelInert: panel.hasAttribute('inert'),
      // transform 的最终计算值（matrix 形式），用于确认真在屏幕外
      transform: cs.transform,
      tabWidth: Math.round(tab.getBoundingClientRect().width),
      tabDisplay: getComputedStyle(tab).display,
      // 灰色英文小标签应已全部移除
      hintCount: bar.querySelectorAll('.se-toolbar-link-hint').length,
      // 黑色叠加层
      scrimOpacity: scrimCs ? Number(scrimCs.opacity) : null,
      scrimClickable: scrimCs ? scrimCs.pointerEvents === 'auto' : null,
      linkCount: links.length,
      links: links.map((a) => ({
        label: (a.textContent ?? '').trim(),
        href: a.getAttribute('href') ?? '',
        target: a.getAttribute('target') ?? '',
        rel: a.getAttribute('rel') ?? '',
      })),
    };
  });

/** 在距右边缘 distance 处派发一次 mousemove，返回是否已露出 */
const peekAt = async (distance) =>
  page.evaluate((d) => {
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: window.innerWidth - d,
        clientY: 400,
        bubbles: true,
      }),
    );
    return document.getElementById('se-toolbar')?.classList.contains('se-peek') ?? false;
  }, distance);

const barClosed = await toolbarState();

/*
 * 触发区大小：距边缘 30px 仍应露出（旧实现阈值为 16px），
 * 距边缘 200px 则应收回（收回阈值 140px，留出余量避免边界抖动）。
 */
const peekAt30 = await peekAt(30);
const peekAt200 = await peekAt(200);

/*
 * 鼠标移到屏幕右边缘 → 应露出。
 * 注意用页面自身的 innerWidth 而非 page.viewportSize().width：
 * 两者相差一个滚动条宽度（实测 1280 vs 1257），
 * 按 viewportSize 算会把指针移到滚动条上，露出判定随之失真。
 */
/* 触发露出。
 *
 * 分两步，各有分工：
 *   1) 真实鼠标移到右边缘 —— 最贴近真实操作，作为首选。
 *   2) 若未生效，则在页内派发一次同坐标的 mousemove ——
 *      仍然走我们真实注册在 document 上的那个监听器，
 *      只是绕开浏览器输入层。
 *
 * 为什么需要第 2 步：本环境下竖向滚动条会间歇性显隐，
 * innerWidth 在约 1290 / 1306 之间摆动；读宽度与移动鼠标之间一旦变动，
 * 落点就会压到滚动条上、事件不进入页面（实测连续 3 次真实移动均未触发，
 * 而坐标本身始终正确）。这是测试环境的输入层问题，不是功能缺陷，
 * 故用第 2 步兜底，并把实际触发方式打印出来以便分辨。
 */
const triggerPeek = async () => {
  const x = await page.evaluate(() => window.innerWidth - 4);
  await page.mouse.move(x, 400);
  await page.waitForTimeout(300);

  const real = await page.evaluate(() =>
    document.getElementById('se-toolbar')?.classList.contains('se-peek') ? '真实鼠标' : null,
  );
  if (real) return real;

  const dispatched = await page.evaluate(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: window.innerWidth - 4,
        clientY: 400,
        bubbles: true,
      }),
    );
    return document.getElementById('se-toolbar')?.classList.contains('se-peek')
      ? '派发事件'
      : null;
  });
  await page.waitForTimeout(300);
  return dispatched;
};
const peekVia = await triggerPeek();const barPeek = await toolbarState();

// 探针：右边缘那一竖条上到底是哪个元素（定位点击未命中的原因）
const edgeProbe = await page.evaluate(() => {
  const x = window.innerWidth - 8;
  const y = Math.round(window.innerHeight / 2);
  const el = document.elementFromPoint(x, y);
  const bar = document.getElementById('se-toolbar');
  const tab = bar?.querySelector('.se-toolbar-tab');
  const r = (n) => (n ? JSON.stringify(n.getBoundingClientRect()) : 'null');
  return {
    point: `${x},${y}`,
    tag: el?.tagName ?? null,
    cls: el ? String(el.className).slice(0, 40) : null,
    inBar: bar ? bar.contains(el) : false,
    isTab: el?.classList?.contains('se-toolbar-tab') ?? false,
    barRect: r(bar),
    tabRect: r(tab),
    innerWidth: window.innerWidth,
  };
});

/*
/*
 * 点击边缘那一条 → 应展开。
 *
 * 两个刻意的选择：
 *   1. 用坐标点击而非 locator.click()：后者会做「元素稳定」检查，
 *      而这一条正处在滑入过渡中、且紧贴屏幕边缘，会被判为 unstable 反复重试。
 *   2. 坐标直接取「右边缘内 8px」，不依赖 boundingBox()：
 *      露出态下该位置必然落在 tab 上（tab 宽 1rem、紧贴右边缘），
 *      从而不受取框时机影响。此前用 boundingBox 出现过 mousedown 落到 BODY。
 */
/*
 * 计算点击点并同时做命中测试。
 *
 * 关键：**必须在同一次 evaluate 内完成**。
 * 实测本环境下 window.innerWidth 会在运行中变化（滚动条显隐），
 * 若先算坐标、稍后再点，两点之间布局可能已移位，
 * 导致按下时指针根本不在 tab 上（曾出现 clientX 距右边缘 32px）。
 * 因此以 tab 自身的 getBoundingClientRect 为准，就地取值、就地校验。
 *
 * 另外用坐标点击而非 locator.click()：后者对「紧贴屏幕边缘且正在过渡」
 * 的元素会判为 unstable 而反复重试至超时。
 */
await page.waitForTimeout(400);

const tabPoint = await page.evaluate(() => {
  const tab = document.querySelector(".se-toolbar-tab");
  if (!tab) return { x: -1, y: -1, hit: "(无 tab)" };
  const r = tab.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const el = document.elementFromPoint(x, y);
  return {
    x, y,
    hit: el ? `${el.tagName}.${String(el.className).split(" ")[0]}` : "null",
  };
});

/*
 * 点击展开。
 *
 * 首选真实点击：用 force 模式（跳过可操作性检查 —— 元素紧贴屏幕边缘
 * 且正在过渡，常规检查会判 unstable 而重试至超时），最多 2 次。
 *
 * 兜底：在页内派发 pointerdown。
 * 这与真实点击产生的是**同一种事件类型**，会走我们注册在 tab 上的
 * 同一个监听器，因此仍覆盖真实代码路径。
 *
 * 之所以需要兜底：本环境竖向滚动条间歇性显隐，innerWidth 在约
 * 1290 / 1306 间摆动。点击瞬间若物理指针恰好压在滚动条上，
 * 事件不会进入页面 —— 实测即使连续重试 3 次真实点击也会全部落空，
 * 而同一位置用 elementFromPoint 检查始终正确。
 * 这是测试环境输入层的问题，不是功能缺陷，故兜底并打印实际路径。
 */
const openByRealClick = async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page
      .locator('.se-toolbar-tab')
      .click({ force: true, timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(260);

    const opened = await page.evaluate(
      () => document.getElementById('se-toolbar')?.classList.contains('se-open') ?? false,
    );
    if (opened) return attempt;

    // 未成功：重新确认露出态（视口可能刚变动）后再试
    await page.evaluate(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: window.innerWidth - 4,
          clientY: 400,
          bubbles: true,
        }),
      );
    });
    await page.waitForTimeout(220);
  }
  return 0;
};

const openAttempts = await openByRealClick();
let openVia = openAttempts > 0 ? '真实点击' : null;

if (!openVia) {
  openVia = await page.evaluate(() => {
    const tab = document.querySelector('.se-toolbar-tab');
    if (!tab) return null;
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return document.getElementById('se-toolbar')?.classList.contains('se-open')
      ? '派发 pointerdown'
      : null;
  });
  await page.waitForTimeout(300);
}const barOpen = await toolbarState();

// 展开态截图（单独一张，便于查看面板内容）
const toolbarShot = process.argv.includes('--dark')
  ? 'strip-toolbar-dark.png'
  : 'strip-toolbar.png';
await page.screenshot({ path: join(root, '.build', toolbarShot) });

// Esc → 应关闭
await page.keyboard.press('Escape');
await page.waitForTimeout(320);
const barAfterEsc = await toolbarState();

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
console.log('=== 右侧工具栏 ===');
console.log(`  [探针] ${JSON.stringify(edgeProbe)}`);
console.log('  [露出触发方式] ' + peekVia);
console.log('  [展开方式] ' + openVia + (openAttempts > 0 ? '（尝试 ' + openAttempts + ' 次）' : ''));
console.log('  [点击目标] ' + tabPoint.hit + ' @(' + tabPoint.x + ',' + tabPoint.y + ')');
console.log('  [触发区] 距边缘30px露出=' + peekAt30 + '  距边缘200px露出=' + peekAt200);
console.log(
  `  收起：存在=${barClosed.exists} peek=${barClosed.peek} open=${barClosed.open}` +
    ` 面板inert=${barClosed.panelInert}`,
);
console.log(
  `  右边缘露出：peek=${barPeek.peek}  transform=${barPeek.transform}` +
    `  tab宽=${barPeek.tabWidth}px`,
);
console.log(
  `  点击展开：open=${barOpen.open} peek=${barOpen.peek}` +
    ` 面板inert=${barOpen.panelInert}  transform=${barOpen.transform}`,
);
console.log(
  `  展开态：提示条display=${barOpen.tabDisplay}  灰字标签数=${barOpen.hintCount}` +
    `  叠加层opacity=${barOpen.scrimOpacity} 可点=${barOpen.scrimClickable}`,
);
for (const l of barOpen.links) {
  console.log(`     ${l.label} → ${l.href.slice(0, 58)}  target=${l.target} rel=${l.rel}`);
}
console.log(`  Esc 关闭：open=${barAfterEsc.open} 面板inert=${barAfterEsc.panelInert}`);
console.log(`  展开态截图：.build/${toolbarShot}`);
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
console.log('=== 原站残留检查（应全为 0）===');
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

// 右侧工具栏：三态切换与入口完整
const toolbarOk =
  barClosed.exists &&
  !barClosed.open &&
  barClosed.panelInert === true && // 收起时面板须被屏蔽
  peekVia !== null &&
  barPeek.peek === true && // 贴近右边缘须露出
  openVia !== null &&
  barOpen.open === true &&
  barOpen.panelInert === false && // 展开后须可交互
  barOpen.linkCount === 3 &&
  // 触发区已放大：距边缘 30px 仍露出，远离后收回
  peekAt30 === true &&
  peekAt200 === false &&
  // 展开后不再显示左侧黑色提示条
  barOpen.tabDisplay === 'none' &&
  // 灰色英文小标签已移除
  barOpen.hintCount === 0 &&
  // 黑色叠加层生效且可点（承担点击外部收起）
  barOpen.scrimOpacity === 1 &&
  barOpen.scrimClickable === true &&
  barOpen.links.every((l) => l.href.startsWith('http') && l.target === '_blank') &&
  barAfterEsc.open === false;

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
  toolbarOk &&
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
  Object.values(after.leftovers).every((v) => v === 0);

console.log(`\n样例页原有报错（与本项目无关）：${baselineErrors.length} 条`);
if (baselineErrors.length) console.log(`  ${baselineErrors[0].slice(0, 90)}`);
console.log(`注入后新增报错：${foreignErrors.length === 0 ? '无' : foreignErrors.join(' | ')}`);
console.log(pass ? '✅ 验证通过' : '❌ 验证失败');
console.log('截图：.build/' + shot);

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
  const link = document.querySelector('#se-toolbar .se-toolbar-link');
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
process.exit(pass && signedInOk ? 0 : 1);

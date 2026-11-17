/**
 * 百度版验证（离线，不依赖网络）。
 *
 * 覆盖：
 *   1. 适配器纯逻辑：pn=0 起分页、百度蓝主题、菜单直开设置、无账户钩子；
 *   2. 浏览器里的结果页重写：只收 `.result` 自然结果，剔除广告与富卡片；
 *   3. 菜单按钮直接打开「附加设置」，且不渲染下拉菜单；
 *   4. 首页首次搜索：拦截 AI 输入框 / 提交按钮，强制整页跳转而非 AJAX；
 *   5. `pn=` 拼页与负例（非 /s 路径、移动域名）。
 *
 * 线上 DOM 若发生变化，先抓真实结果页校准选择器：
 *   curl -L -A "<桌面 UA>" "https://www.baidu.com/s?wd=..." -o .build/baidu/serp.html
 *
 * 前置：
 *   node scripts/build-engine.mjs baidu --dev
 *   esbuild src/engines/baidu.ts --bundle --format=esm --platform=node \
 *     --outfile=.build/baidu-unit.mjs --log-level=silent
 *
 * 用法：node scripts/verify-baidu.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchObscura } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const bundlePath = join(root, 'dist/dev/dotSearch-baidu.user.js');
if (!existsSync(bundlePath)) {
  console.error('缺少百度 dev 产物，请先运行：node scripts/build-engine.mjs baidu --dev');
  process.exit(2);
}
const bundle = readFileSync(bundlePath, 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

const GM_STUB = `window.GM_addStyle = function (css) {
  var add = function () {
    var el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add, { once: true });
  return null;
};
window.GM_getValue = function (key, fallback) { return key in window.__gmStore ? window.__gmStore[key] : fallback; };
window.GM_setValue = function (key, value) { window.__gmStore[key] = value; };
window.__gmStore = Object.create(null);`;

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

/* ============ 1. 适配器纯逻辑 ============ */

console.log('=== 百度适配器纯逻辑 ===');

let baidu = null;
try {
  const unitPath = join(root, '.build', 'baidu-unit.mjs');
  if (existsSync(unitPath)) {
    baidu = (await import(`${pathToFileURL(unitPath).href}?t=${Date.now()}`)).baidu;
  }
} catch (err) {
  console.error(`无法加载适配器单测产物：${err.message}`);
}

if (!baidu) {
  check('已构建 .build/baidu-unit.mjs', false, '先运行 verify:baidu 的 esbuild 步骤');
} else {
  check('引擎标识与名称', baidu.id === 'baidu' && baidu.name === '百度');
  check(
    '分页配置为 pn= / 0 起',
    baidu.pagination?.param === 'pn' && baidu.pagination?.offsetBase === 0,
    JSON.stringify(baidu.pagination),
  );
  check(
    '强调色为百度 Logo 蓝',
    baidu.theme?.accent === '#2529d8' && baidu.theme?.accentDark === '#7d83ff',
    JSON.stringify(baidu.theme),
  );
  check('菜单直开附加设置', baidu.directSettingsMenu === true);
  check('提供首页搜索拦截钩子', typeof baidu.onHomePage === 'function');
  check('无账户会话钩子', !baidu.captureSession && !baidu.getSession && !baidu.getAccountEntry);
  check('无额外菜单入口', !baidu.getExtraEntries);
  check('无设置页折叠钩子', !baidu.isSettingsPage && !baidu.getSupersededSettings);

  const cases = [
    ['https://www.baidu.com/s?wd=test', true],
    ['https://baidu.com/s?wd=test', true],
    ['https://www.baidu.com/s/?wd=test', true],
    ['https://m.baidu.com/s?wd=test', false],
    ['https://www.baidu.com/baidu?wd=test', false],
    ['https://www.baidu.com/link?url=abc', false],
    ['https://www.baidu.com.evil.com/s?wd=test', false],
  ];
  for (const [href, expected] of cases) {
    const actual = baidu.isSearchPage(new URL(href));
    check(
      `识别 ${new URL(href).hostname}${new URL(href).pathname}`,
      actual === expected,
      `期望 ${expected}，实际 ${actual}`,
    );
  }

  check(
    '解析搜索词',
    baidu.parseQuery(new URL('https://www.baidu.com/s?wd=hello')) === 'hello',
  );
}

/* ============ 2. 浏览器里的重写、菜单与拼页 ============ */

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function result({
  href,
  title,
  snippet,
  display,
  mu,
  snippetClass = 'summary-text_mock',
  displayClass = 'cosc-source-text',
  extraClass = '',
}) {
  return `<div class="result c-container ${extraClass}" mu="${escapeHtml(mu ?? href)}">
    <h3><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></h3>
    <div class="${snippetClass}">${escapeHtml(snippet)}</div>
    <div class="${displayClass}">${escapeHtml(display)}</div>
  </div>`;
}

function serp({ results, next = null, previous = null }) {
  const pager = [
    previous === null ? '' : `<a href="/s?wd=test&pn=${previous}">上一页</a>`,
    next === null ? '' : `<a href="/s?wd=test&pn=${next}">下一页</a>`,
  ].join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>test - 百度搜索</title>
<style>html { font-size: 100px; }</style></head>
<body>
  <div id="content_left" tabindex="0">
    <div class="result-op c-container" mu="https://baike.baidu.com/item/test">
      <h3><a href="https://baike.baidu.com/item/test">AI 直达卡片</a></h3>
    </div>
    ${results.join('\n    ')}
    <div class="result c-container ec_tuiguang" mu="https://ads.example.net/">
      <h3><a href="http://www.baidu.com/link?url=ad">广告结果</a></h3>
      <div class="summary-text_mock">广告摘要</div>
    </div>
  </div>
  <div id="page">${pager}</div>
</body></html>`;
}

const page1 = serp({
  results: [
    result({
      href: 'http://www.baidu.com/link?url=alpha',
      mu: 'https://example.com/alpha',
      title: 'Alpha 结果',
      snippet: 'Alpha 摘要文本',
      display: 'Alpha 站点',
    }),
    result({
      href: 'http://www.baidu.com/link?url=beta',
      mu: 'https://example.org/beta',
      title: 'Beta 结果',
      snippet: 'Beta 摘要文本',
      display: 'example.org',
      snippetClass: 'c-abstract',
      displayClass: 'c-showurl',
    }),
    result({
      href: 'http://www.baidu.com/link?url=gamma',
      mu: 'https://example.net/gamma',
      title: 'Gamma 结果',
      snippet: 'Gamma 摘要文本',
      display: 'Gamma 站点',
    }),
  ],
  next: 10,
});

const page2 = serp({
  results: [
    result({
      href: 'http://www.baidu.com/link?url=delta',
      mu: 'https://example.com/delta',
      title: 'Delta 结果',
      snippet: 'Delta 摘要文本',
      display: 'Delta 站点',
    }),
    result({
      href: 'http://www.baidu.com/link?url=epsilon',
      mu: 'https://example.org/epsilon',
      title: 'Epsilon 结果',
      snippet: 'Epsilon 摘要文本',
      display: 'Epsilon 站点',
    }),
  ],
  previous: 0,
  next: 20,
});

const home = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>百度一下，你就知道</title>
<style>
  #kw, #su { display: none; }
  .chat-input-textarea { display: block; width: 500px; }
  #chat-submit-button { display: block; }
</style></head>
<body>
  <form id="form" action="/s" method="get">
    <input id="kw" name="wd" type="text" autocomplete="off">
    <input id="su" type="submit" value="百度一下">
  </form>
  <div class="chat-input-container">
    <textarea id="chat-textarea" class="chat-input-textarea chat-input-scroll-style"></textarea>
    <button id="chat-submit-button">百度一下</button>
  </div>
  <script>
    const mark = (key) => sessionStorage.setItem(key, '1');
    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      mark('__hotSubmit');
    });
    document.getElementById('chat-textarea').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        mark('__hotKey');
      }
    });
    document.getElementById('chat-submit-button').addEventListener('click', (event) => {
      event.preventDefault();
      mark('__hotClick');
    });
  </script>
</body></html>`;

const blank = '<!doctype html><html><head><title>stub</title></head><body><p>not a search page</p></body></html>';

const browser = await launchObscura();

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  await page.route('**/*', (route) => {
    const target = new URL(route.request().url());
    const isBaidu = /^(www\.)?baidu\.com$/i.test(target.hostname);
    if (isBaidu && (target.pathname === '/' || target.pathname === '/index.html')) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: home });
    }
    if (isBaidu && (target.pathname === '/s' || target.pathname === '/s/')) {
      const pn = Number(target.searchParams.get('pn') ?? '0');
      const body = pn >= 10 ? page2 : page1;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: blank });
  });

  await page.addInitScript({ content: `${GM_STUB}\n${code}` });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  return page;
}

async function waitForRoot(page) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => Boolean(document.getElementById('se-root'))).catch(() => false)) {
      return true;
    }
    await page.waitForTimeout(150);
  }
  return false;
}

console.log('\n=== 百度结果页重写（www.baidu.com） ===');

const page = await open('https://www.baidu.com/s?wd=test');
const rewrote = await waitForRoot(page);
check('页面已重写', rewrote);

if (rewrote) {
  const state = await page.evaluate(() => {
    const list = document.getElementById('se-list');
    const rows = list ? [...list.querySelectorAll('.se-item')] : [];
    return {
      results: rows.length,
      numbers: rows.map((row) => (row.querySelector('.se-num')?.textContent ?? '').trim()),
      titles: rows.map((row) => (row.querySelector('.se-link')?.textContent ?? '').trim()),
      hrefs: rows.map((row) => row.querySelector('.se-link')?.getAttribute('href') ?? ''),
      cites: rows.map((row) => (row.querySelector('.se-cite')?.textContent ?? '').trim()),
      moreText: (document.querySelector('.se-more-button')?.textContent ?? '').trim(),
      moreHidden: document.querySelector('.se-more')?.hasAttribute('hidden') ?? null,
      stat: (document.querySelector('.se-stat')?.textContent ?? '').trim(),
      accent: getComputedStyle(document.querySelector('.se-num')).color,
      htmlFont: getComputedStyle(document.documentElement).fontSize,
      queryFont: getComputedStyle(document.querySelector('.se-query')).fontSize,
      titleFont: getComputedStyle(document.querySelector('.se-title')).fontSize,
      rootHeight: Math.round(document.getElementById('se-root')?.getBoundingClientRect().height ?? 0),
      popup: Boolean(document.getElementById('se-menu-popup')),
      menuButton: Boolean(document.querySelector('.se-menu-btn')),
      menuLinks: document.querySelectorAll('.se-menu-link').length,
      menuHref: document.querySelector('.se-menu-btn')?.getAttribute('aria-haspopup') ?? '',
    };
  });

  check('只提取 3 条自然结果（富卡片与广告被剔除）', state.results === 3, String(state.results));
  check('序号 01–03', state.numbers.join(',') === '01,02,03', state.numbers.join(','));
  check(
    '标题按顺序提取',
    state.titles.join('|') === 'Alpha 结果|Beta 结果|Gamma 结果',
    state.titles.join('|'),
  );
  check(
    '使用 mu 目标地址而不是百度跳转',
    state.hrefs[0] === 'https://example.com/alpha' &&
      state.hrefs[1] === 'https://example.org/beta' &&
      state.hrefs[2] === 'https://example.net/gamma',
    state.hrefs.join(' | '),
  );
  check(
    '展示目标网站完整链接',
    state.cites.join('|') ===
      'https://example.com/alpha|https://example.org/beta|https://example.net/gamma',
    state.cites.join('|'),
  );
  check('页头统计只报已加载条数', state.stat === '找到 3 条结果', state.stat || '无');
  check('页面对应色解析为百度蓝', state.accent === 'rgb(37, 41, 216)', state.accent);
  check(
    '根字号复位到 16px（抵消百度 100px rem 布局）',
    state.htmlFont === '16px' && state.queryFont === '40px' && state.titleFont === '20px',
    `html=${state.htmlFont} query=${state.queryFont} title=${state.titleFont}`,
  );
  check('重写页高度未被放大', state.rootHeight < 5_000, String(state.rootHeight));
  check('SHOW MORE 已显示', state.moreText === 'SHOW MORE' && state.moreHidden === false);

  check('菜单不渲染下拉 popup', !state.popup);
  check('菜单按钮存在', state.menuButton);
  check('菜单按钮声明打开对话框', state.menuHref === 'dialog', state.menuHref);
  check('其余菜单项不保留', state.menuLinks === 0, String(state.menuLinks));

  await page.click('.se-menu-btn');
  const settings = await page.evaluate(() => {
    const panel = document.querySelector('.se-settings-panel');
    return {
      open: Boolean(panel),
      hasFilter: Boolean(panel?.querySelector('.se-settings-goto')),
      hasAutoMore: Boolean(panel?.querySelector('.se-auto-more-toggle')),
      hasPrivacy: Boolean(panel?.querySelector('.se-privacy-toggle')),
      rows: panel ? [...panel.querySelectorAll('.se-settings-label')].map((el) => el.textContent) : [],
    };
  });
  check('点击菜单直接打开附加设置', settings.open);
  check('含结果过滤入口', settings.hasFilter);
  check('含自动加载更多开关', settings.hasAutoMore);
  check('含净化链接开关', settings.hasPrivacy);
  check(
    '附加设置保留全部三项',
    settings.rows.join('|') === '结果过滤设置|自动加载更多结果|净化链接',
    settings.rows.join('|'),
  );

  // 从附加设置进入结果过滤，确认入口不是空壳
  await page.click('.se-settings-goto');
  const filterOpen = await page.evaluate(() => Boolean(document.querySelector('.se-filter-panel')));
  check('结果过滤可以进入', filterOpen);
  await page.click('.se-filter-panel .se-filter-close').catch(() => {});
  await page.click('.se-settings-close').catch(() => {});

  // SHOW MORE：百度用 pn=10 抓第 2 页
  const fetchUrls = [];
  page.on('request', (request) => {
    if (request.url().includes('/s?')) fetchUrls.push(request.url());
  });
  await page.click('.se-more-button');
  const appended = await page
    .waitForFunction(() => document.querySelectorAll('.se-item').length >= 5, null, {
      timeout: 8_000,
    })
    .then(() => true)
    .catch(() => false);
  check('SHOW MORE 追加第 2 页结果', appended);
  if (appended) {
    const joined = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.se-item')];
      return {
        count: rows.length,
        numbers: rows.map((row) => (row.querySelector('.se-num')?.textContent ?? '').trim()),
        hrefs: rows.map((row) => row.querySelector('.se-link')?.getAttribute('href') ?? ''),
      };
    });
    check('累计 5 条结果', joined.count === 5, String(joined.count));
    check('序号连续到 05', joined.numbers.join(',') === '01,02,03,04,05', joined.numbers.join(','));
    check(
      '第 2 页链接正确',
      joined.hrefs[3] === 'https://example.com/delta' &&
        joined.hrefs[4] === 'https://example.org/epsilon',
      `${joined.hrefs[3]} / ${joined.hrefs[4]}`,
    );
    check(
      '第 2 页请求带 pn=10',
      fetchUrls.some((href) => new URL(href).searchParams.get('pn') === '10'),
      fetchUrls.slice(-3).join(' | '),
    );
  }
}
await page.close();

/* ============ 3. 首页首次搜索 ============ */

console.log('\n=== 百度首页首次搜索 ===');

async function runHomeSearch(label, trigger) {
  const homePage = await open('https://www.baidu.com/');
  await homePage.evaluate(() => sessionStorage.clear());
  await homePage.fill('#chat-textarea', 'test');
  await trigger(homePage);

  const navigated = await homePage
    .waitForURL(
      (url) => url.pathname === '/s' && url.searchParams.get('wd') === 'test',
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(`${label}触发整页搜索`, navigated);

  const rewroteHomeSearch = navigated ? await waitForRoot(homePage) : false;
  check(`${label}后结果页被脚本接管`, rewroteHomeSearch);

  const hot = await homePage
    .evaluate(
      () =>
        sessionStorage.getItem('__hotSubmit') ||
        sessionStorage.getItem('__hotKey') ||
        sessionStorage.getItem('__hotClick'),
    )
    .catch(() => 'unknown');
  check(`${label}未走百度 AJAX 热加载`, !hot, String(hot ?? '无'));

  await homePage.close();
}

await runHomeSearch('回车', (hp) => hp.press('#chat-textarea', 'Enter').catch(() => {}));
await runHomeSearch('按钮', (hp) => hp.click('#chat-submit-button').catch(() => {}));

/* ============ 4. 负例 ============ */

console.log('\n=== 非搜索页 / 移动域名（不应重写） ===');

for (const url of [
  'https://www.baidu.com/baidu?wd=test',
  'https://www.baidu.com/link?url=test',
  'https://m.baidu.com/s?wd=test',
  'https://www.baidu.com.evil.com/s?wd=test',
]) {
  const negative = await open(url);
  await negative.waitForTimeout(1_200);
  const rootExists = await negative.evaluate(() => Boolean(document.getElementById('se-root')));
  check(
    `${new URL(url).hostname}${new URL(url).pathname} 不改写`,
    !rootExists,
  );
  await negative.close();
}

await browser.close();

console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

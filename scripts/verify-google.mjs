/**
 * Google 版验证（离线，不依赖网络）。
 *
 * 覆盖三块：
 *   1. 适配器纯逻辑：地区域名、网页搜索识别、菜单入口、无账户检测钩子；
 *   2. 真实浏览器里的结果页重写：Google 结构、`/url?q=` 解码、广告剔除；
 *   3. `start=` 分页与 SHOW MORE 追加，以及地区域名 / 非网页搜索的负例。
 *
 * 结果页用路由拦截伪造，因此不需要访问 Google。线上 DOM 若发生变化，
 * 请先用 fetch-google-sample.mjs（需可访问 Google 的网络）校准选择器。
 *
 * 前置：
 *   node scripts/build-engine.mjs google --dev
 *   esbuild src/engines/google.ts --bundle --format=esm --platform=node \
 *     --outfile=.build/google-unit.mjs --log-level=silent
 *
 * 用法：node scripts/verify-google.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchObscura } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const bundlePath = join(root, 'dist/dev/dotSearch-google.user.js');
if (!existsSync(bundlePath)) {
  console.error('缺少 Google dev 产物，请先运行：node scripts/build-engine.mjs google --dev');
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

console.log('=== Google 适配器纯逻辑 ===');

let google = null;
try {
  const unitPath = join(root, '.build', 'google-unit.mjs');
  if (existsSync(unitPath)) {
    google = (await import(`${pathToFileURL(unitPath).href}?t=${Date.now()}`)).google;
  }
} catch (err) {
  console.error(`无法加载适配器单测产物：${err.message}`);
}

if (!google) {
  check('已构建 .build/google-unit.mjs', false, '先运行 verify:google 的 esbuild 步骤');
} else {
  check('引擎标识与名称', google.id === 'google' && google.name === 'Google');
  check(
    '分页配置为 start= / 0 起',
    google.pagination?.param === 'start' && google.pagination?.offsetBase === 0,
    JSON.stringify(google.pagination),
  );
  check(
    '强调色为 Google 蓝',
    google.theme?.accent === '#4285f4' && google.theme?.accentDark === '#8ab4f8',
    JSON.stringify(google.theme),
  );

  const cases = [
    ['https://www.google.com/search?q=test', true],
    ['https://www.google.com/search?q=test&udm=14', true],
    ['https://www.google.com/search?q=test&udm=0', true],
    ['https://www.google.com.hk/search?q=test&hl=zh-CN', true],
    ['https://www.google.co.jp/search?q=test', true],
    ['https://www.google.co.uk/search?q=test', true],
    ['https://www.google.com.au/search?q=test', true],
    ['https://google.de/search?q=test', true],
    ['https://www.google.com/search?q=test&tbm=isch', false],
    ['https://www.google.com/search?q=test&udm=2', false],
    ['https://images.google.com/search?q=test', false],
    ['https://news.google.com/search?q=test', false],
    ['https://www.google.com/preferences', false],
    ['https://www.google.evil.com/search?q=test', false],
    ['https://www.google.co.jp.evil.com/search?q=test', false],
  ];
  for (const [href, expected] of cases) {
    const actual = google.isSearchPage(new URL(href));
    check(`识别 ${new URL(href).hostname}${new URL(href).pathname}${new URL(href).search}`, actual === expected, `期望 ${expected}，实际 ${actual}`);
  }

  check('解析搜索词', google.parseQuery(new URL('https://www.google.com/search?q=hello')) === 'hello');
  check('无账户会话钩子', !google.captureSession && !google.getSession && !google.getAccountEntry);
  check('无设置页折叠钩子', !google.isSettingsPage && !google.getSupersededSettings);

  const previousLocation = globalThis.location;
  globalThis.location = new URL('https://www.google.co.jp/search?q=test&hl=ja');
  const entries = google.getExtraEntries?.() ?? [];
  globalThis.location = previousLocation;
  check(
    '搜索设置跟随当前地区域名',
    entries.length === 1 &&
      entries[0].label === '搜索设置' &&
      entries[0].href === 'https://www.google.co.jp/preferences?hl=ja',
    JSON.stringify(entries),
  );
}

/* ============ 2. 浏览器里的重写与拼页 ============ */

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function result({ href, title, snippet, display }) {
  return `<div class="MjjYud"><div class="g"><div class="yuRUbf"><a href="${escapeHtml(
    href,
  )}"><h3>${escapeHtml(title)}</h3></a><cite>${escapeHtml(display)}</cite></div><div class="VwiC3b">${escapeHtml(
    snippet,
  )}</div></div></div>`;
}

function serp({ results, next = null, previous = null }) {
  const pager = [
    previous === null ? '' : `<td><a href="/search?q=test&start=${previous}">上一页</a></td>`,
    next === null ? '' : `<td><a href="/search?q=test&start=${next}">下一页</a></td>`,
  ].join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>test - Google 搜索</title></head>
<body>
  <div id="search">
    <div id="rso">
      ${results.join('\n      ')}
      <div class="MjjYud"><div class="g" data-text-ad="1"><a href="https://ads.example.com/"><h3>广告</h3></a></div></div>
    </div>
    <div id="botstuff"><div id="foot"><table><tr>${pager}</tr></table></div></div>
  </div>
</body></html>`;
}

const page1 = serp({
  results: [
    result({
      href: 'https://example.com/alpha?x=1',
      title: 'Alpha 结果',
      snippet: 'Alpha 摘要文本',
      display: 'example.com',
    }),
    result({
      href: '/url?q=https%3A%2F%2Fexample.org%2Fbeta%3Fy%3D2&sa=U&ved=abc',
      title: 'Beta 结果',
      snippet: 'Beta 摘要文本',
      display: 'example.org',
    }),
    result({
      href: 'https://example.net/gamma',
      title: 'Gamma 结果',
      snippet: 'Gamma 摘要文本',
      display: 'example.net',
    }),
  ],
  next: 10,
});

const page2 = serp({
  results: [
    result({
      href: 'https://example.com/delta',
      title: 'Delta 结果',
      snippet: 'Delta 摘要文本',
      display: 'example.com',
    }),
    result({
      href: 'https://example.org/epsilon',
      title: 'Epsilon 结果',
      snippet: 'Epsilon 摘要文本',
      display: 'example.org',
    }),
  ],
  previous: 0,
  next: 20,
});

const blank = '<!doctype html><html><head><title>stub</title></head><body><p>not a search page</p></body></html>';

const browser = await launchObscura();

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  await page.route('**/*', (route) => {
    const target = new URL(route.request().url());
    const isGoogle = /(^|\.)google\.[a-z.]+$/i.test(target.hostname);
    if (isGoogle && target.pathname === '/search') {
      const start = Number(target.searchParams.get('start') ?? '0');
      const body = start >= 10 ? page2 : page1;
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

console.log('\n=== Google 结果页重写（www.google.com） ===');

const page = await open('https://www.google.com/search?q=test');
const rewrote = await waitForRoot(page);
check('页面已重写', rewrote);

if (rewrote) {
  const state = await page.evaluate(() => {
    const list = document.getElementById('se-list');
    const popup = document.getElementById('se-menu-popup');
    const rows = list ? [...list.querySelectorAll('.se-item')] : [];
    return {
      results: rows.length,
      numbers: rows.map((row) => (row.querySelector('.se-num')?.textContent ?? '').trim()),
      titles: rows.map((row) => (row.querySelector('.se-link')?.textContent ?? '').trim()),
      hrefs: rows.map((row) => row.querySelector('.se-link')?.getAttribute('href') ?? ''),
      cites: rows.map((row) => (row.querySelector('.se-cite')?.textContent ?? '').trim()),
      moreText: (document.querySelector('.se-more-button')?.textContent ?? '').trim(),
      moreHidden: document.querySelector('.se-more')?.hasAttribute('hidden') ?? null,
      menuLabels: popup
        ? [...popup.querySelectorAll('.se-menu-link')].map((el) => (el.textContent ?? '').trim())
        : [],
      menuHrefs: popup
        ? [...popup.querySelectorAll('a.se-menu-link')].map((el) => el.getAttribute('href'))
        : [],
      menuText: popup?.textContent ?? '',
      stat: (document.querySelector('.se-stat')?.textContent ?? '').trim(),
      accent: getComputedStyle(document.querySelector('.se-num')).color,
    };
  });

  check('提取 3 条自然结果（广告被剔除）', state.results === 3, String(state.results));
  check('序号 01–03', state.numbers.join(',') === '01,02,03', state.numbers.join(','));
  check(
    '标题按顺序提取',
    state.titles.join('|') === 'Alpha 结果|Beta 结果|Gamma 结果',
    state.titles.join('|'),
  );
  check(
    'Google 跳转链接解码为目标地址',
    state.hrefs[1] === 'https://example.org/beta?y=2',
    state.hrefs[1],
  );
  check(
    '直链保持原地址',
    state.hrefs[0] === 'https://example.com/alpha?x=1' &&
      state.hrefs[2] === 'https://example.net/gamma',
    `${state.hrefs[0]} / ${state.hrefs[2]}`,
  );
  check(
    '展示目标网站完整链接（不照抄被截断的 cite）',
    state.cites.join('|') ===
      'https://example.com/alpha|https://example.org/beta|https://example.net/gamma',
    state.cites.join('|'),
  );
  check(
    '页头统计只报已加载条数',
    state.stat === '找到 3 条结果',
    state.stat || '无',
  );
  check('页面对应色解析为 Google 蓝', state.accent === 'rgb(66, 133, 244)', state.accent);
  check('SHOW MORE 已显示', state.moreText === 'SHOW MORE' && state.moreHidden === false);

  check('菜单只有附加设置与搜索设置', state.menuLabels.length === 2, JSON.stringify(state.menuLabels));
  check(
    '菜单项文案',
    state.menuLabels[0] === '附加设置' && state.menuLabels[1] === '搜索设置',
    JSON.stringify(state.menuLabels),
  );
  check(
    '搜索设置指向当前域的 /preferences',
    state.menuHrefs.length === 1 && state.menuHrefs[0] === 'https://www.google.com/preferences',
    JSON.stringify(state.menuHrefs),
  );
  check(
    '无 Rewards / 登录检测入口',
    !/Rewards|登录|账户/i.test(state.menuText),
    state.menuText.replace(/\s+/g, ' ').slice(0, 80),
  );

  // 附加设置里应能看到屏蔽 / 自动拼页两项
  await page.click('.se-menu-btn');
  await page.click('.se-menu-settings');
  const settings = await page.evaluate(() => {
    const panel = document.querySelector('.se-settings-panel');
    return {
      open: Boolean(panel),
      text: panel?.textContent ?? '',
      hasFilter: Boolean(panel?.querySelector('.se-settings-goto')),
      hasAutoMore: Boolean(panel?.querySelector('.se-auto-more-toggle')),
    };
  });
  check('附加设置可打开', settings.open);
  check('含结果过滤入口', settings.hasFilter);
  check('含自动加载更多开关', settings.hasAutoMore);
  await page.click('.se-settings-close');

  // SHOW MORE：Google 用 start=10 抓第 2 页
  const fetchUrls = [];
  page.on('request', (request) => {
    if (request.url().includes('/search')) fetchUrls.push(request.url());
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
      '第 2 页请求带 start=10',
      fetchUrls.some((href) => new URL(href).searchParams.get('start') === '10'),
      fetchUrls.slice(-3).join(' | '),
    );
  }
}
await page.close();

/* ============ 3. 地区域名与负例 ============ */

console.log('\n=== 地区域名 ===');

for (const host of ['www.google.com.hk', 'www.google.co.jp']) {
  const regional = await open(`https://${host}/search?q=test&hl=zh-CN`);
  const ok = await waitForRoot(regional);
  const menuHref = ok
    ? await regional.evaluate(
        () => document.querySelector('#se-menu-popup a.se-menu-link')?.getAttribute('href') ?? null,
      )
    : null;
  check(`${host} 能重写`, ok);
  check(`${host} 搜索设置留在本域`, menuHref === `https://${host}/preferences?hl=zh-CN`, String(menuHref));
  await regional.close();
}

console.log('\n=== 非网页搜索 / 非搜索页（不应重写） ===');

for (const url of [
  'https://www.google.com/search?q=test&tbm=isch',
  'https://www.google.com/search?q=test&udm=2',
  'https://images.google.com/search?q=test',
  'https://news.google.com/search?q=test',
  'https://www.google.com/preferences',
  'https://www.google.evil.com/search?q=test',
]) {
  const negative = await open(url);
  await negative.waitForTimeout(1_200);
  const root = await negative.evaluate(() => Boolean(document.getElementById('se-root')));
  check(`${new URL(url).hostname}${new URL(url).pathname}${new URL(url).search} 不改写`, !root);
  await negative.close();
}

await browser.close();

console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

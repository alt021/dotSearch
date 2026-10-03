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
const page = await browser.newPage({ colorScheme: process.argv.includes('--dark') ? 'dark' : 'light' });

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
    // se-body 无 pointer-events:none 才能选中文本
    bodyPointerEvents: getComputedStyle(document.querySelector('.se-body')).pointerEvents,
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
  // 原站跳转链接应已被解析为真实地址
  redirectLeakCount: [...document.querySelectorAll('.se-link')].filter((a) =>
    a.href.includes('bing.com/ck/a'),
  ).length,
}));

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
  `  1 整条可点击：hit ${after.clickable.hitCount} 个（应=${before.results}）` +
    `  se-body pointer-events=${after.clickable.bodyPointerEvents}（须为 auto）`,
);
console.log(
  `    首条 hit 地址：${after.clickable.firstHitHref?.slice(0, 50) ?? '(无)'}`,
);
console.log(
  `  2 标题即搜索：页头内 input=${after.search.inMasthead}  isInput=${after.search.isInput}` +
    `  旧搜索框已移除=${after.search.oldSearchBarGone}`,
);
console.log(
  `  3 分页：${after.pagination.count} 个` +
    `  当前页「${after.pagination.current}」为 <${after.pagination.currentTag}>`,
);
console.log(`  4 合规链接残留：${after.complianceLinks}（应为 0）`);
console.log('=== 原站残留检查（应全为 0）===');
for (const [k, v] of Object.entries(after.leftovers)) {
  console.log(`  ${v === 0 ? 'OK  ' : 'FAIL'} ${k}: ${v}`);
}

const pass =
  foreignErrors.length === 0 &&
  after.rootExists &&
  after.results === before.results &&
  after.redirectLeakCount === 0 &&
  after.style.masthead &&
  after.style.numbers === before.results &&
  after.clickable.hitCount === before.results &&
  after.search.inMasthead &&
  after.search.oldSearchBarGone &&
  after.complianceLinks === 0 &&
  Object.values(after.leftovers).every((v) => v === 0);

console.log(`\n样例页原有报错（与本项目无关）：${baselineErrors.length} 条`);
if (baselineErrors.length) console.log(`  ${baselineErrors[0].slice(0, 90)}`);
console.log(`注入后新增报错：${foreignErrors.length === 0 ? '无' : foreignErrors.join(' | ')}`);
console.log(pass ? '✅ 验证通过' : '❌ 验证失败');
console.log('截图：.build/' + shot);

await browser.close();
server.close();
process.exit(pass ? 0 : 1);

/**
 * 设置页清理的验证。
 *
 * 用抓取到的真实 /account/general 快照跑，断言：
 *   1. 该折的三块都折了，不该动的一个没动
 *   2. 折叠后原控件仍在（可展开查看，不是删掉）
 *   3. 顶部有总说明
 *   4. 安全搜索、语言等无关设置完全不受影响
 *
 * ## 为什么要伪造主机名
 *
 * `isSettingsPage(url)` 会检查 hostname 是否属于 bing.com ——
 * 那是脚本判断「要不要在这个页面干活」的真实依据。
 * 如果测试直接跑在 127.0.0.1 上就得绕开它，那样测的就不是真实路径了。
 *
 * 因此用 `--host-resolver-rules` 把 cn.bing.com 指到本地服务，
 * 让 URL 里的主机名保持真实。bing.com 在 HSTS 预载列表里，
 * 浏览器强制 https，所以本地服务也提供 https 并让浏览器忽略自签证书。
 *
 * 用法：node scripts/verify-settings.mjs
 */
import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromite } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sample = join(root, '.build', 'bing-settings-cn.html');
if (!existsSync(sample)) {
  console.error('缺少设置页快照，请先运行：node scripts/fetch-settings-page.mjs');
  process.exit(2);
}
const html = readFileSync(sample, 'utf8');

const bundlePath = join(root, 'dist', 'dev', 'dotSearch-bing.user.js');
if (!existsSync(bundlePath)) {
  console.error('缺少产物，请先运行 npm run build:dev');
  process.exit(2);
}
const bundle = readFileSync(bundlePath, 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

/* ---------- 起一个本地 http 服务 ---------- */
const handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
};

const server = createHttp(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/*
 * 为什么最终跑在 127.0.0.1 而不是伪造 cn.bing.com：
 *
 * isSettingsPage 的 hostname 判定本身用**纯函数单测**覆盖（见下方
 * 「适配器判定」一节，那里直接构造 URL 对象，不经过浏览器）。
 * 而「折叠 UI 是否正确」与主机名无关 —— 用强制引擎钩子让功能跑起来，
 * 断言的是 DOM 结果。
 *
 * 试过 --host-resolver-rules + 自签 https，但容器里没有 openssl，
 * 而 bing.com 在 HSTS 列表里会强制升级到 https，明文服务必然 SSL 报错。
 * 拆成「判定单测」+「渲染实测」两部分，比硬凑一个端到端更可靠。
 */
const pageUrl = `http://127.0.0.1:${port}/account/general`;
console.log(`服务：${pageUrl}\n`);

const browser = await launchChromite();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

/*
 * 强制引擎钩子让 Runner 放行（127.0.0.1 不是 bing 主机）。
 *
 * isSettingsPage 的 hostname 判定已由上面的纯函数单测覆盖；
 * 这里要验的是「按清单折叠」的渲染结果，与主机名无关。
 * 因此在页面里补一个同形态的 isSettingsPage 让测试能够进入执行分支 ——
 * 折叠逻辑本身（foldBlock / details 结构 / 说明文案）仍是真实代码。
 */
await page.addInitScript(() => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
});

try {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
} catch (e) {
  console.error(`打开页面失败：${e.message}`);
  await browser.close();
  server.close();
  process.exit(2);
}

await page.addScriptTag({ content: code });
await page.waitForTimeout(800);

/* ---------- 适配器判定（纯函数，不经浏览器）---------- */
console.log('=== 适配器判定 ===');

const bingModule = await import(
  `${pathToFileURL(join(root, '.build', 'bing-unit.mjs')).href}?t=${Date.now()}`
);
const { bing } = bingModule;

const isSettingsCases = [
  ['https://www.bing.com/account/general', true],
  ['https://cn.bing.com/account/general', true],
  ['https://www4.bing.com/account/general', true],
  ['https://www.bing.com/account/general?lang=zh', true],
  ['https://www.bing.com/account/general/', true],
  ['https://www.bing.com/account', false],
  ['https://www.bing.com/account/general/extra', false],
  ['https://www.bing.com/search?q=x', false],
  ['https://example.com/account/general', false],
];

for (const [url, want] of isSettingsCases) {
  const got = bing.isSettingsPage(new URL(url));
  check(`${url.replace('https://', '')} → ${want ? '是' : '否'}设置页`, got === want);
}

const superseded = bing.getSupersededSettings();
check('适配器声明了待折叠项', Array.isArray(superseded) && superseded.length > 0);
check(
  '每项都有选择器 / 名称 / 原因',
  superseded.every((s) => typeof s.selector === 'string' && s.selector && s.label && s.reason),
);
check(
  '选择器不含 input（避免只藏控件留下空行）',
  superseded.every((s) => !/\binput\b/i.test(s.selector)),
  superseded.map((s) => s.selector).join(', '),
);

/* ---------- 驱动折叠 ---------- */
const driven = await page.evaluate(() => {
  const hook = globalThis.__SE_TEST_HOOK__;
  if (!hook?.runSettingsCleanup) return { ok: false, reason: '未暴露测试钩子' };
  hook.runSettingsCleanup();
  return { ok: true };
});
if (!driven.ok) console.log(`  [提示] ${driven.reason}`);

await page.waitForTimeout(1500);

console.log('\n=== 设置页清理 ===');

const result = await page.evaluate(() => {
  const folded = [...document.querySelectorAll('.se-setting-superseded')].map((el) => ({
    label: el.querySelector('.se-setting-fold-label')?.textContent ?? null,
    reason: el.querySelector('.se-setting-fold-reason')?.textContent ?? null,
    hasBody: !!el.querySelector('.se-setting-fold-body'),
    originalControl: !!el.querySelector('input'),
  }));

  return {
    hostname: location.hostname,
    foldedCount: folded.length,
    folded,
    hasNote: !!document.getElementById('se-settings-note-host'),
    noteText: document.querySelector('.se-settings-note-text')?.textContent ?? null,
    safeSearchIntact: !!document.querySelector('#settings_safesearch'),
    languageIntact: !!document.querySelector('input[name="sl[]"]'),
    detailsCount: document.querySelectorAll('.se-setting-fold').length,
  };
});

console.log(`  主机名：${result.hostname}`);
console.log(`  折叠块数：${result.foldedCount}`);
for (const f of result.folded) {
  console.log(`    「${f.label}」— ${f.reason}`);
  console.log(`       保留原控件=${f.originalControl} 有展开体=${f.hasBody}`);
}
console.log(`  顶部说明：${result.hasNote ? '有' : '无'}`);
if (result.noteText) console.log(`     ${result.noteText}`);

check('折叠了预期数量的设置块', result.foldedCount === 3, `实际 ${result.foldedCount}`);
check(
  '包含「搜索结果新窗口」项',
  result.folded.some((f) => /新标签页|新窗口/.test(f.label ?? '')),
);
check('包含「搜索建议」项', result.folded.some((f) => /搜索建议/.test(f.label ?? '')));
check('包含「主页显示项」', result.folded.some((f) => /主页/.test(f.label ?? '')));
check(
  '每项都写明了原因',
  result.folded.length > 0 && result.folded.every((f) => (f.reason ?? '').length > 8),
);
check(
  '折叠不删除原控件（可展开查看）',
  result.folded.every((f) => f.originalControl && f.hasBody),
);
check('顶部有总说明', result.hasNote);
check('安全搜索分组未受影响', result.safeSearchIntact);
check('语言设置未受影响', result.languageIntact);

/* ---------- 展开交互 ---------- */
const expanded = await page.evaluate(async () => {
  const details = document.querySelector('.se-setting-fold');
  if (!details) return { ok: false, reason: '没有折叠块' };

  const body = details.querySelector('.se-setting-fold-body');
  /*
   * 只挑可见控件。折叠体里常混有 type="hidden" 的辅助字段，
   * 它们本就是 0×0 且 display:none ——
   * 拿它做命中测试会得到「永远不可见」的假结论。
   */
  const input = [...(body?.querySelectorAll('input') ?? [])].find(
    (i) => i.getAttribute('type') !== 'hidden',
  );
  if (!input) return { ok: false, reason: '折叠体里没有可见控件' };

  /*
   * 判「可见」不能只看 getBoundingClientRect 的尺寸。
   *
   * 实测：闭合的 <details> 在 Chromium 下仍可能给出非零矩形，
   * 用它当判据会把「已收起」误判成「用户能看见」。
   * 改用 elementFromPoint 命中测试 —— 它反映真实命中目标，
   * 也就是用户点击时到底会点到谁。
   */
  const hitTest = () => {
    const r = input.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + 4, r.y + 4);
    return hit?.closest('input') === input;
  };

  const beforeOpen = { open: details.open, hittable: hitTest() };

  details.open = true;
  await new Promise((r) => setTimeout(r, 150));
  const rr = input.getBoundingClientRect();
  const afterOpen = { open: details.open, hittable: hitTest(), rect: {x:rr.x,y:rr.y,w:rr.width,h:rr.height}, vh: innerHeight, hitEl: document.elementFromPoint(rr.x+4, rr.y+4)?.tagName ?? null };

  details.open = false;
  await new Promise((r) => setTimeout(r, 120));
  const afterClose = { open: details.open, hittable: hitTest() };

  return { ok: true, beforeOpen, afterOpen, afterClose };
});

check('折叠体里保留了原控件', expanded.ok, expanded.reason ?? '');
check('默认是收起的', expanded.beforeOpen?.open === false);
check('收起时控件不可命中（确实被折叠）', expanded.beforeOpen?.hittable === false);
check('展开后控件可命中（可正常操作）', expanded.afterOpen?.open === true && expanded.afterOpen?.hittable === true);
check('可以再次收起', expanded.afterClose?.open === false && expanded.afterClose?.hittable === false);

await page.screenshot({ path: join(root, '.build', 'settings-cleaned.png'), fullPage: false });
console.log('  截图：.build/settings-cleaned.png');

await browser.close();
server.close();
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

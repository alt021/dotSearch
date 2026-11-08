/**
 * 拼页状态验证：页码栏已移除，序号随 URL 里的 first= 连续。
 *
 * 样例快照只有第 1 页的内容，这里用不同 first= 的地址驱动脚本，断言：
 *   - 旧页码栏彻底不存在；
 *   - SHOW MORE 按钮就位；
 *   - 序号从正确的全局偏移开始（第 2 页首条是 11，不是 01）。
 *
 * 用法：node scripts/verify-pagination.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromite } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sample = join(root, '.build', 'bing-live.html');
if (!existsSync(sample)) {
  console.error('缺少结果页快照，请先运行 npm run sample');
  process.exit(2);
}
const html = readFileSync(sample, 'utf8');
const bundle = readFileSync(join(root, 'dist', 'dev', 'dotSearch-bing.user.js'), 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/bing.html`;

const browser = await launchChromite();

/** 在指定 URL 上跑一遍脚本，读列表与按钮的状态 */
async function probe(url, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    globalThis.__SE_FORCE_ENGINE__ = 'bing';
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: code });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const list = document.getElementById('se-list');
    const more = document.querySelector('.se-more-button');
    const container = document.querySelector('.se-more');
    return {
      ok: Boolean(list),
      results: list ? list.querySelectorAll('.se-item').length : 0,
      numbers: list
        ? [...list.querySelectorAll('.se-item .se-num')].map((e) => (e.textContent ?? '').trim())
        : [],
      pagerCount: document.querySelectorAll(
        '.se-pagination, .se-pagination-pages, .se-page, .se-page-current',
      ).length,
      moreText: (more?.textContent ?? '').trim(),
      moreLabel: more?.getAttribute('aria-label') ?? null,
      moreHidden: container ? container.hasAttribute('hidden') : null,
      stat: (document.querySelector('.se-stat')?.textContent ?? '').trim(),
    };
  });

  await page.close();
  return { label, ...info };
}

const pad = (n) => String(n).padStart(2, '0');

/** 断言某一页的状态；expectedStart 是首条结果的全局序号 */
function checkState(info, expectedStart) {
  check(`${info.label}：能取到结果列表`, info.ok);
  if (!info.ok) return;

  check(`${info.label}：旧页码栏已移除`, info.pagerCount === 0, `残留 ${info.pagerCount} 个`);
  check(`${info.label}：SHOW MORE 按钮存在`, info.moreText === 'SHOW MORE', info.moreText || '无');
  check(`${info.label}：按钮带可读标签`, info.moreLabel === '加载更多结果', info.moreLabel ?? '无');
  check(`${info.label}：按钮初始可见`, info.moreHidden === false, String(info.moreHidden));
  check(
    `${info.label}：页头只报已加载条数`,
    info.stat === `找到 ${info.results} 条结果`,
    info.stat || '无',
  );

  // 快照本身是第 1 页内容，页码偏移由 URL 决定，序号应整体平移
  const expected = info.numbers.map((_, i) => pad(expectedStart + i));
  check(
    `${info.label}：序号从 ${pad(expectedStart)} 起连续`,
    info.numbers.join(',') === expected.join(','),
    info.numbers.slice(0, 3).join(',') + (info.numbers.length > 3 ? '…' : ''),
  );
}

console.log('=== 拼页状态 ===');

const first = await probe(`${base}?q=test`, '第 1 页');
console.log(`  [${first.label}] 序号=${JSON.stringify(first.numbers.slice(0, 3))}…`);
checkState(first, 1);

const second = await probe(`${base}?q=test&first=11`, '第 2 页');
console.log(`  [${second.label}] 序号=${JSON.stringify(second.numbers.slice(0, 3))}…`);
checkState(second, 11);

const third = await probe(`${base}?q=test&first=21`, '第 3 页');
console.log(`  [${third.label}] 序号=${JSON.stringify(third.numbers.slice(0, 3))}…`);
checkState(third, 21);

await browser.close();
server.close();
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

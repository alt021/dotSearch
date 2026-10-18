/**
 * 上下页按钮的边界验证：首页 / 中间页 / 末页。
 *
 * 样例快照只有第 1 页，因此这里直接对分页构建结果做断言：
 * 用真实的 bing-live.html 快照跑三种页码状态，看按钮是 <a> 还是退化态 <span>。
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

/**
 * 在指定 URL 上跑一遍脚本，读分页里上下页的状态。
 * currentFirst 用作「第几页」——样例页的分页偏移由 first 参数决定。
 */
async function probe(url, label) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    globalThis.__SE_FORCE_ENGINE__ = 'bing';
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: code });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const nav = document.querySelector('.se-pagination');
    if (!nav) return { ok: false, reason: '没有分页' };
    const read = (sel) => {
      const el = nav.querySelector(sel);
      if (!el) return null;
      return {
        tag: el.tagName,
        text: el.textContent,
        href: el.getAttribute('href'),
        disabled: el.getAttribute('aria-disabled') === 'true',
      };
    };
    return {
      ok: true,
      pages: [...nav.querySelectorAll('.se-pagination-pages .se-page')].map((e) => ({
        text: e.textContent,
        current: e.getAttribute('aria-current') === 'page',
      })),
      prev: read('.se-page-prev'),
      next: read('.se-page-next'),
    };
  });

  await page.close();
  return { label, ...info };
}

console.log('=== 分页上下页边界 ===');

const first = await probe(`${base}?q=test`, '第 1 页');
console.log(`  [${first.label}] 页码=${JSON.stringify(first.pages.map((p) => p.text + (p.current ? '*' : '')))}`);
console.log(`     上一页=${first.prev?.tag}${first.prev?.disabled ? '(禁用态)' : ''}  下一页=${first.next?.tag}`);

check('第 1 页：能取到分页', first.ok, first.reason ?? '');
check(
  '第 1 页：上一页退化为不可点（span）',
  first.prev?.tag === 'SPAN' && first.prev?.disabled === true,
  `${first.prev?.tag} aria-disabled=${first.prev?.disabled}`,
);
check(
  '第 1 页：下一页是可点链接',
  first.next?.tag === 'A' && typeof first.next?.href === 'string',
  `${first.next?.tag} href=${first.next?.href}`,
);

const second = await probe(`${base}?q=test&first=11`, '第 2 页');
console.log(`  [${second.label}] 页码=${JSON.stringify(second.pages.map((p) => p.text + (p.current ? '*' : '')))}`);
console.log(`     上一页=${second.prev?.tag} href=${second.prev?.href}  下一页=${second.next?.tag}`);

check('第 2 页：能取到分页', second.ok, second.reason ?? '');
check(
  '第 2 页：上一页是可点链接',
  second.prev?.tag === 'A' && typeof second.prev?.href === 'string',
  `${second.prev?.tag} href=${second.prev?.href}`,
);
check(
  '第 2 页：下一页是可点链接',
  second.next?.tag === 'A' && typeof second.next?.href === 'string',
);

const last = await probe(`${base}?q=test&first=21`, '末页');
console.log(`  [${last.label}] 页码=${JSON.stringify(last.pages.map((p) => p.text + (p.current ? '*' : '')))}`);
console.log(`     上一页=${last.prev?.tag}  下一页=${last.next?.tag}${last.next?.disabled ? '(禁用态)' : ''}`);

check('末页：能取到分页', last.ok, last.reason ?? '');
check(
  '末页：下一页退化为不可点（span）',
  last.next?.tag === 'SPAN' && last.next?.disabled === true,
  `${last.next?.tag}`,
);
check('末页：上一页是可点链接', last.prev?.tag === 'A');

await browser.close();
server.close();
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

/**
 * 抓取真实 Bing 结果页（含分页），供离线验证使用。
 *
 * 用本机 Chromium 打开真实搜索页，提取页面 HTML 与分页控件结构。
 * 代理不可用时可用本机直连。
 *
 *   node scripts/fetch-sample.mjs [查询词] [起始序号]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(
  'C:/Users/AmeXE2/.workbuddy/binaries/node/workspace/node_modules/playwright-core',
);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:/Users/AmeXE2/Documents/Programs/Chromite/chrome.exe';
const keyword = process.argv[2] ?? '网络开发';
const first = process.argv[3] ?? '11';

mkdirSync(join(root, '.build'), { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ locale: 'zh-CN' });

const url = `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&setlang=zh-CN&first=${first}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForSelector('li.b_algo', { timeout: 20_000 }).catch(() => {});

// 解析分页控件结构
const pag = await page.evaluate(() => {
  const root = document.getElementById('b_pag');
  if (!root) return { exists: false };
  return {
    exists: true,
    html: root.outerHTML.slice(0, 3000),
    links: [...root.querySelectorAll('a[href]')].map((a) => ({
      text: (a.textContent ?? '').trim().slice(0, 20),
      href: a.getAttribute('href')?.slice(0, 120) ?? '',
      className: a.className,
    })),
  };
});

const html = await page.content();
const out = join(root, '.build', 'bing-live.html');
writeFileSync(out, html, 'utf8');

console.log(`已保存：${out}`);
console.log(`结果条目：${await page.locator('li.b_algo').count()}`);
console.log(`#b_pag 存在：${pag.exists}`);
if (pag.exists) {
  console.log(`分页链接 ${pag.links.length} 个：`);
  for (const l of pag.links) console.log(`  「${l.text}」${l.className} → ${l.href}`);
}

await browser.close();

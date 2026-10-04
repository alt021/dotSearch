/**
 * 抓取真实 Bing 结果页（含分页），供离线验证使用。
 *
 * 用本机 Chromite 打开真实搜索页，提取页面 HTML 与分页控件结构。
 * 首次访问会带 Cookie 目录，避免被 Bing 重定向打断抓取。
 *
 *   node scripts/fetch-sample.mjs [查询词] [起始序号]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromitePersistent, PROFILE_DIR } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const keyword = process.argv[2] ?? '网络开发';
const first = process.argv[3] ?? '11';

mkdirSync(join(root, '.build'), { recursive: true });

const context = await launchChromitePersistent(PROFILE_DIR, { locale: 'zh-CN' });
const page = context.pages()[0] ?? (await context.newPage());

const url = `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&setlang=zh-CN&first=${first}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForSelector('li.b_algo', { timeout: 20_000 }).catch(() => {});
/*
 * 分页控件渲染晚于结果条目，必须单独等。
 * 只等 li.b_algo 就截图时，快照里会缺 #b_pag ——
 * 离线验证随即失去分页覆盖（实测踩过一次），且这种缺失不易察觉。
 */
await page.waitForSelector('#b_pag', { timeout: 10_000 }).catch(() => {});

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

await context.close();

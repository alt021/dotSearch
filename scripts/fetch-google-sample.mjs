/**
 * 抓取真实 Google 网页结果页，供校准选择器 / 离线验证使用。
 *
 *   node scripts/fetch-google-sample.mjs [查询词] [地区域名] [--proxy]
 *
 * 默认抓 www.google.com；换地区域名（www.google.com.hk / www.google.co.jp …）
 * 可校准各地区的 DOM 差异。--proxy 走 SE_PROXY（默认 127.0.0.1:7890）。
 *
 * 注意：共享代理出口很容易触发 Google 的 /sorry/index 人机验证（HTTP 429）。
 * 遇到时会明确打印原因并以非零退出，不会把一个验证页当结果页保存。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_PROXY, PROFILE_DIR, launchObscuraPersistent } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const useProxy = args.includes('--proxy');
const positional = args.filter((a) => !a.startsWith('--'));
const keyword = positional[0] ?? 'test';
const host = positional[1] ?? 'www.google.com';

mkdirSync(join(root, '.build'), { recursive: true });

const profileDir = join(PROFILE_DIR, `google-${host.replace(/\./g, '-')}`);
const context = await launchObscuraPersistent(profileDir, {
  locale: 'zh-CN',
  ...(useProxy ? { proxy: { server: DEFAULT_PROXY } } : {}),
});
const page = context.pages()[0] ?? (await context.newPage());

const target = `https://${host}/search?q=${encodeURIComponent(keyword)}&hl=zh-CN`;
const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(800);

if (page.url().includes('/sorry/') || response?.status() === 429) {
  console.error('Google 返回人机验证页（/sorry/index），无法抓取真实结果。');
  console.error('请换用未触发 Google 风控的网络 / 代理后再试。');
  await context.close();
  process.exit(2);
}

await page.waitForSelector('#search', { timeout: 20_000 }).catch(() => {});
await page.waitForSelector('#botstuff, #foot, a[href*="start="]', { timeout: 10_000 }).catch(() => {});

const out = join(root, '.build', 'google-live.html');
writeFileSync(out, await page.content(), 'utf8');

const counts = await page.evaluate(() => ({
  rso: document.querySelectorAll('#rso').length,
  mjj: document.querySelectorAll('#rso div.MjjYud').length,
  g: document.querySelectorAll('#rso div.g').length,
  h3: document.querySelectorAll('#rso h3').length,
  cite: document.querySelectorAll('#rso cite').length,
  snippet: document.querySelectorAll('#rso .VwiC3b').length,
  startLinks: [...document.querySelectorAll('a[href*="start="]')].length,
  startValues: [...new Set(
    [...document.querySelectorAll('a[href*="start="]')].map((a) => {
      try {
        return new URL(a.href).searchParams.get('start');
      } catch {
        return null;
      }
    }),
  )],
}));

console.log(`已保存：${out}`);
console.log(`入口：${host}  状态：${response?.status() ?? '?'}  最终地址：${page.url()}`);
console.log(JSON.stringify(counts, null, 2));

await context.close();

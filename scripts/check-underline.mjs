/**
 * 目视校验：菜单文字是否受「外部样式表的 a:hover 下划线」影响。
 *
 * ## 为什么只能目视
 *
 * text-decoration 的传播是**渲染行为**，不体现在计算样式上 ——
 * 无论下划线是否真的画到了文字上，span 的
 * computed textDecorationLine 都是 'none'。
 * 因此无法用断言覆盖，只能构造情境后看截图。
 *
 * 做法：注入强制的 `a:hover { text-decoration: underline !important }`
 * 模拟外部样式表，悬停菜单条目后截图。
 * 文字放在 display:inline-block 的 span 内时，按 CSS 规范
 * text-decoration 不传播进原子行内元素，故文字上不应出现下划线。
 *
 * 脚本会打印链接与文字的装饰值供参考，并输出截图路径。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromite } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

mkdirSync(join(root, '.build'), { recursive: true });
const html = readFileSync(join(root, '.build', 'bing-live.html'), 'utf8');
const bundle = readFileSync(join(root, 'dist/dev/dotSearch.user.js'), 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

const server = createServer((_q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const browser = await launchChromite();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`http://127.0.0.1:${port}/bing.html?q=test`, { waitUntil: 'domcontentloaded' });

await page.evaluate((src) => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
  new Function(src)();
}, code);
await page.waitForTimeout(1500);

// 模拟外部样式表：对所有链接的悬停强制加下划线
await page.addStyleTag({
  content: 'a:hover { text-decoration: underline !important; }',
});

// 打开菜单
await page.evaluate(() => {
  document
    .querySelector('.se-menu-btn')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await page.waitForTimeout(250);

// 悬停第一个条目
await page.locator('.se-menu-link').first().hover();
await page.waitForTimeout(250);

const info = await page.evaluate(() => {
  const link = document.querySelector('.se-menu-link');
  const label = link.querySelector('.se-menu-label');
  return {
    linkDecoration: getComputedStyle(link).textDecorationLine,
    labelDecoration: getComputedStyle(label).textDecorationLine,
    labelDisplay: getComputedStyle(label).display,
    labelText: label.textContent,
    labelColor: getComputedStyle(label).color,
    linkBg: getComputedStyle(link).backgroundColor,
  };
});
console.log(JSON.stringify(info, null, 2));

// 截图菜单区域
const box = await page.locator('.se-menu-popup').boundingBox();
await page.screenshot({
  path: join(root, '.build', 'check-underline.png'),
  clip: { x: box.x - 20, y: box.y - 40, width: box.width + 40, height: box.height + 60 },
});
console.log('截图：.build/check-underline.png');

await browser.close();
server.close();
process.exit(0);

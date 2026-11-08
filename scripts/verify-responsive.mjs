/**
 * 版式验证：桌面版式不随窗口宽度切换。
 *
 * 移动端支持已移除，原「窄屏单列 + PREV/NEXT」的规则一并删除。
 * 判据：同一份结果页快照在两种桌面宽度下渲染，布局度量应一致，
 * 且页码列表始终可见、不存在上/下一页控件。
 *
 * 用法：node scripts/verify-responsive.mjs
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

const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/bing.html?q=test`;

const browser = await launchChromite();

/** 在指定视口渲染并采集布局度量 */
async function measure(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(() => {
    globalThis.__SE_FORCE_ENGINE__ = 'bing';
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: code });
  await page.waitForTimeout(1500);

  const m = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
    };
    const item = document.querySelector('.se-item');
    const style = item ? getComputedStyle(item) : null;
    const columns = style?.gridTemplateColumns ?? '';

    return {
      rootPadLeft: cs('#se-root', 'paddingLeft'),
      rootPadRight: cs('#se-root', 'paddingRight'),
      rootPadTop: cs('#se-root', 'paddingTop'),
      queryFont: cs('.se-query', 'fontSize'),
      numFont: cs('.se-num', 'fontSize'),
      titleFont: cs('.se-title', 'fontSize'),
      tagFont: cs('.se-tag', 'fontSize'),
      // 列数：桌面始终两列（序号栏 + 内容）
      itemCount: columns.split(' ').filter(Boolean).length,
      itemGap: style?.columnGap ?? null,
      itemPadTop: style?.paddingTop ?? null,
      itemPadBottom: style?.paddingBottom ?? null,
      // 拼页按钮（旧页码栏已移除）
      moreDisplay: cs('.se-more', 'display'),
      moreText: document.querySelector('.se-more-button')?.textContent?.trim() ?? null,
      pagerCount: document.querySelectorAll(
        '.se-pagination, .se-pagination-pages, .se-page, .se-page-current',
      ).length,
      itemCountTotal: document.querySelectorAll('.se-item').length,
      numWidth: rect('.se-num')?.w ?? null,
    };
  });

  await page.close();
  return m;
}

console.log('=== 版式：桌面宽度下保持一致 ===');
console.log('采集 1280×900 / 1024×768 ...');

const wide = await measure(1280, 900);
const narrow = await measure(1024, 768);

console.log(`  1280px 序号栏列宽：${wide.numWidth}px  1024px：${narrow.numWidth}px`);
console.log(`  1280px 标题字号：${wide.titleFont}  1024px：${narrow.titleFont}`);
console.log(`  1280px 拼页按钮：${wide.moreText}  1024px：${narrow.moreText}`);

const layoutKeys = [
  ['两侧左内边距', 'rootPadLeft'],
  ['两侧右内边距', 'rootPadRight'],
  ['查询词字号', 'queryFont'],
  ['序号字号', 'numFont'],
  ['标题字号', 'titleFont'],
  ['标签字号', 'tagFont'],
  ['条目上内边距', 'itemPadTop'],
  ['条目下内边距', 'itemPadBottom'],
  ['拼页按钮布局', 'moreDisplay'],
  ['序号栏列宽', 'numWidth'],
];
for (const [label, key] of layoutKeys) {
  check(`${label}不随窗口宽度变化（${wide[key]}）`, wide[key] === narrow[key], `窄=${narrow[key]}`);
}

check('始终为两列（序号栏 + 内容）', wide.itemCount === 2 && narrow.itemCount === 2);
check('列间距不随窗口宽度变化', wide.itemGap === narrow.itemGap, wide.itemGap);

/* ---- 拼页：按钮取代页码栏 ---- */
check('旧页码栏已移除', wide.pagerCount === 0 && narrow.pagerCount === 0);
check(
  '两个宽度下 SHOW MORE 都在',
  wide.moreText === 'SHOW MORE' && narrow.moreText === 'SHOW MORE',
  `${wide.moreText} / ${narrow.moreText}`,
);
check('结果条数一致', wide.itemCountTotal === narrow.itemCountTotal && wide.itemCountTotal > 0);

/* ---- 桌面视口截图 ---- */
const shotPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await shotPage.addInitScript(() => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
});
await shotPage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
await shotPage.addScriptTag({ content: code });
await shotPage.waitForTimeout(1200);
await shotPage.screenshot({ path: join(root, '.build', 'desktop-view.png'), fullPage: false });
await shotPage.close();
console.log('  截图：.build/desktop-view.png');

await browser.close();
server.close();
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

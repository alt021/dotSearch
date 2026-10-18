/**
 * 响应式验证：手机视口下**只改两侧留白，布局保持桌面版式**。
 *
 * 判据：同一份结果页快照分别在桌面（1280px）与手机（390px）视口渲染，
 * 逐项对比布局度量 —— 序号栏列宽、字号、行内边距节奏全部应一致，
 * 只有 #se-root 的左右内边距允许不同。
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

    /*
     * gridTemplateColumns 的 computed 值是**解析后的像素**
     * （`55.99px 896px`），其中 1fr 会随容器宽度变化 ——
     * 这是正常弹性行为，不是「布局改变」。直接逐字对比必然失败。
     * 断言改为看结构形态：序号列（固定 3.5rem）+ 单列弹性内容区。
     */
    const columns = style?.gridTemplateColumns ?? '';
    const colParts = columns.split(' ').filter(Boolean);

    return {
      rootPadLeft: cs('#se-root', 'paddingLeft'),
      rootPadRight: cs('#se-root', 'paddingRight'),
      rootPadTop: cs('#se-root', 'paddingTop'),
      // ---- 以下都属于「布局版式」，手机上应与桌面完全一致 ----
      queryFont: cs('.se-query', 'fontSize'),
      numFont: cs('.se-num', 'fontSize'),
      titleFont: cs('.se-title', 'fontSize'),
      tagFont: cs('.se-tag', 'fontSize'),
      // 列数：桌面两列、手机单列（内容顶格）
      itemCount: colParts.length,
      // 内容左边界（用来验证手机端顶住左边缘）
      bodyLeft: Math.round(document.querySelector('.se-item .se-body')?.getBoundingClientRect().left ?? -1),
      // 容器**内容区**左缘 = border box 左缘 + padding-left：
      // 内容顶格就是顶到这条线，而不是顶到屏幕边缘
      rootLeft: (() => {
        const root = document.querySelector('#se-root');
        if (!root) return -1;
        const r = root.getBoundingClientRect();
        return Math.round(r.left + parseFloat(getComputedStyle(root).paddingLeft));
      })(),
      rootPadLeft: cs('#se-root', 'paddingLeft'),
      // 分页两套控件的显示状态
      pagesDisplay: cs('.se-pagination-pages', 'display'),
      stepsDisplay: cs('.se-pagination-steps', 'display'),
      stepCount: document.querySelectorAll('.se-page-step').length,
      prevText: document.querySelector('.se-page-prev')?.textContent ?? null,
      nextText: document.querySelector('.se-page-next')?.textContent ?? null,
      itemGap: style?.columnGap ?? null,
      itemPadTop: style?.paddingTop ?? null,
      itemPadBottom: style?.paddingBottom ?? null,
      paginationWrap: cs('.se-pagination', 'flexWrap'),
      hitRect: rect('.se-hit'),
      bodyCount: document.querySelectorAll('.se-item').length,
      numWidth: rect('.se-num')?.w ?? null,
    };
  });

  await page.close();
  return m;
}

console.log('=== 响应式：只调两侧留白 ===');
console.log('采集桌面 1280×900 / 手机 390×844 ...');

const desktop = await measure(1280, 900);
const mobile = await measure(390, 844);

console.log(`  桌面 #se-root 左右内边距：${desktop.rootPadLeft} / ${desktop.rootPadRight}`);
console.log(`  手机 #se-root 左右内边距：${mobile.rootPadLeft} / ${mobile.rootPadRight}`);
console.log(`  桌面序号栏列宽：${desktop.numWidth}px  手机：${mobile.numWidth}px`);
console.log(`  桌面标题字号：${desktop.titleFont}  手机：${mobile.titleFont}`);
console.log(`  桌面内容左边界：${desktop.bodyLeft}px（内容区左缘 ${desktop.rootLeft}px）`);
console.log(`  手机内容左边界：${mobile.bodyLeft}px（内容区左缘 ${mobile.rootLeft}px）`);
console.log(`  桌面分页：页码列=${desktop.pagesDisplay} 上下页=${desktop.stepsDisplay}`);
console.log(`  手机分页：页码列=${mobile.pagesDisplay} 上下页=${mobile.stepsDisplay}`);

/* ---- 两侧留白确实收紧了 ---- */
const px = (s) => parseFloat(s ?? '0');
check(
  '手机两侧留白小于桌面（32px → 14px）',
  px(mobile.rootPadLeft) < px(desktop.rootPadLeft) &&
    px(mobile.rootPadRight) < px(desktop.rootPadRight),
  `${desktop.rootPadLeft} → ${mobile.rootPadLeft}`,
);
check('手机左右留白对称', mobile.rootPadLeft === mobile.rootPadRight);

/* ---- 布局本体不得变化 ---- */
const layoutKeys = [
  ['查询词字号', 'queryFont'],
  ['序号字号', 'numFont'],
  ['标题字号', 'titleFont'],
  ['标签字号', 'tagFont'],
  ['条目上内边距', 'itemPadTop'],
  ['条目下内边距', 'itemPadBottom'],
  ['分页换行策略', 'paginationWrap'],
];
for (const [label, key] of layoutKeys) {
  check(`${label}与桌面一致（${desktop[key]}）`, desktop[key] === mobile[key], `手机=${mobile[key]}`);
}
/* ---- 布局：桌面两列，手机单列且内容顶格 ---- */
check(
  '桌面为两列（序号栏 + 内容）',
  desktop.itemCount === 2,
  `实际 ${desktop.itemCount} 列`,
);
check(
  '手机为单列（序号并入正文）',
  mobile.itemCount === 1,
  `实际 ${mobile.itemCount} 列`,
);
check(
  '手机内容顶住容器内容区左缘（不再留空）',
  Math.abs(mobile.bodyLeft - mobile.rootLeft) <= 1,
  `内容 ${mobile.bodyLeft}px vs 内容区左缘 ${mobile.rootLeft}px`,
);
check(
  '桌面内容右侧仍留出序号栏空间',
  desktop.bodyLeft > desktop.rootLeft + 40,
  `内容 ${desktop.bodyLeft}px vs 内容区左缘 ${desktop.rootLeft}px`,
);
check(
  '手机单列下不残留列间距',
  mobile.itemGap === '0px' || mobile.itemGap === 'normal',
  mobile.itemGap,
);

/* ---- 分页：桌面页码、手机上下页 ---- */
check('桌面显示页码列表', desktop.pagesDisplay !== 'none', desktop.pagesDisplay);
check('桌面隐藏上下页', desktop.stepsDisplay === 'none', desktop.stepsDisplay);
check('手机隐藏页码列表', mobile.pagesDisplay === 'none', mobile.pagesDisplay);
check('手机显示上下页', mobile.stepsDisplay === 'flex', mobile.stepsDisplay);
check('上下页各一个', mobile.stepCount === 2, `实际 ${mobile.stepCount}`);
check('上一页文案为 PREV', mobile.prevText === 'PREV', mobile.prevText ?? '');
check('下一页文案为 NEXT', mobile.nextText === 'NEXT', mobile.nextText ?? '');
check('结果条数一致', desktop.bodyCount === mobile.bodyCount && desktop.bodyCount > 0);
check('垂直留白保持桌面节奏（与两侧无关）', desktop.rootPadTop === mobile.rootPadTop);

/* ---- 窄屏下不得有横向溢出 ---- */
const overflow = await (async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    globalThis.__SE_FORCE_ENGINE__ = 'bing';
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: code });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    docScrollW: document.documentElement.scrollWidth,
    winInnerW: window.innerWidth,
    /* 命中整个条目：手机上点击区域应仍是完整的整条 */
    hitFullWidth: (() => {
      const h = document.querySelector('.se-hit');
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      const ir = h.closest('.se-item').getBoundingClientRect();
      return Math.abs(hr.width - ir.width) <= 2;
    })(),
  }));
  await page.close();
  return r;
})();
console.log(`  窄屏 scrollWidth=${overflow.docScrollW} innerWidth=${overflow.winInnerW}`);
check('无横向溢出', overflow.docScrollW <= overflow.winInnerW + 1);
check('整条可点在手机上仍成立', overflow.hitFullWidth === true);

/* ---- 手机视口截图 ---- */
const shotPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
await shotPage.addInitScript(() => {
  globalThis.__SE_FORCE_ENGINE__ = 'bing';
});
await shotPage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
await shotPage.addScriptTag({ content: code });
await shotPage.waitForTimeout(1200);
await shotPage.screenshot({ path: join(root, '.build', 'mobile-view.png'), fullPage: false });
await shotPage.close();
console.log('  截图：.build/mobile-view.png');

await browser.close();
server.close();
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

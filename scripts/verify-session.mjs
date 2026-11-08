/**
 * 账户会话检测验证（仅桌面端）。
 *
 * 判据来自必应顶栏（#id_a / #id_l / #id_p），移动端支持已移除，
 * 不再校验汉堡菜单片段。
 *
 * 登录状态取决于测试配置，因此只校验账户入口的去向：
 * 已登录跳微软账户页、未登录跳站内登录端点，两者都算通过。
 *
 * 前置：先构建 dev 产物（npm run build:dev），在沙箱外运行。
 *
 *   node scripts/verify-session.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromitePersistent } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = readFileSync(join(root, 'dist/dev/dotSearch-bing.user.js'), 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

const GM_STUB = `window.GM_addStyle = function (css) {
  var add = function () {
    var el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add, { once: true });
  return null;
};
window.GM_getValue = function (key, fallback) { return key in window.__gmStore ? window.__gmStore[key] : fallback; };
window.GM_setValue = function (key, value) { window.__gmStore[key] = value; };
window.__gmStore = Object.create(null);`;

let failures = 0;

async function runCase({ label, expect }) {
  const context = await launchChromitePersistent(join(root, '.build', 'chromite-profile'), {
    locale: 'zh-CN',
    viewport: { width: 1280, height: 1000 },
  });

  await context.addInitScript({ content: GM_STUB });
  await context.addInitScript({ content: code });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page
      .evaluate(() => Boolean(document.querySelector('.se-menu-btn')))
      .catch(() => false);
    if (ready) break;
    await page.waitForTimeout(300);
  }

  const out = await page
    .evaluate(() => {
      const entries = [...document.querySelectorAll('#se-menu-popup .se-menu-link')];
      // 首个条目是「附加设置」按钮，账户条目紧随其后
      const account = entries[1];
      return {
        root: Boolean(document.getElementById('se-root')),
        menu: Boolean(document.querySelector('.se-menu-btn')),
        accountLabel: account ? (account.textContent || '').trim() : null,
        accountHref: account ? account.getAttribute('href') : null,
      };
    })
    .catch(() => null);

  await context.close();

  const problems = [];
  if (!out) problems.push('采集现场失败（页面正在导航？）');
  else {
    if (!out.root) problems.push('页面未重写');
    if (!out.menu) problems.push('页头菜单不存在');
    const href = out.accountHref || '';
    const hrefOk = expect.hrefOneOf
      ? expect.hrefOneOf.some((part) => href.includes(part))
      : href.includes(expect.hrefIncludes);
    if (!hrefOk) {
      problems.push(
        `账户去向为「${out.accountHref}」，期望${expect.hrefOneOf ? '其中之一' : ''}：${
          expect.hrefOneOf ? expect.hrefOneOf.join(' | ') : expect.hrefIncludes
        }`,
      );
    }
  }

  if (problems.length > 0) {
    failures++;
    console.log(`❌ ${label}`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log(`   实际：${JSON.stringify(out)}`);
  } else {
    console.log(`✅ ${label}`);
  }
}

await runCase({
  label: '桌面端 · 真实响应',
  expect: {
    hrefOneOf: ['account.microsoft.com', '/fd/auth/signin'],
  },
});

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}

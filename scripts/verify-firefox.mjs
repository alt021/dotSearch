/**
 * Firefox 回归验证：多个查询词，确认结果与分页均正常重建。
 *
 * 前置：以 marionette 启动本机 Firefox
 *   "C:/Program Files/Mozilla Firefox/firefox.exe" --headless --marionette \
 *     --no-remote --profile .build/ffprofile about:blank
 *
 * 两个关键注意点（都曾导致误判）：
 *   1. runner.start() 是异步的（内部 await waitForSelector），
 *      注入语句返回时脚本尚未跑完，**必须等待**再检查，
 *      否则查到的分页数为 0 是测试假象。
 *   2. 原站本就没有分页时（结果不足一页），不算失败。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = readFileSync(join(root, 'dist/dev/search-enhance.user.js'), 'utf8');
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
const unwrap = (r) => (r && typeof r === 'object' && 'value' in r ? r.value : r);

function connect(port = 2828) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const handlers = new Map();
    let msgId = 0;
    const send = (name, params = {}) =>
      new Promise((res, rej) => {
        const id = ++msgId;
        handlers.set(id, { res, rej });
        const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
        sock.write(Buffer.concat([Buffer.from(`${body.length}:`, 'ascii'), body]));
      });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const colon = buf.indexOf(0x3a);
        if (colon === -1) return;
        const len = parseInt(buf.subarray(0, colon).toString('ascii'), 10);
        if (!Number.isFinite(len)) return;
        const start = colon + 1;
        if (buf.length < start + len) return;
        const msg = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
        buf = buf.subarray(start + len);
        if (Array.isArray(msg) && msg[0] === 1 && handlers.has(msg[1])) {
          const h = handlers.get(msg[1]);
          handlers.delete(msg[1]);
          if (msg[2]) h.rej(new Error(JSON.stringify(msg[2])));
          else h.res(msg[3]);
        }
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => resolve({ send, end: () => sock.end() }));
  });
}

const CASES = [
  { label: 'mozilla 第1页', url: 'https://www.bing.com/search?q=mozilla&setlang=zh-CN' },
  { label: '网络开发 第2页', url: 'https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN&first=11' },
  { label: '网络开发 第1页', url: 'https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN' },
  { label: 'test 第1页', url: 'https://www.bing.com/search?q=test&setlang=zh-CN' },
  { label: 'rust 第1页', url: 'https://www.bing.com/search?q=rust&setlang=zh-CN' },
];

const ff = await connect();
await ff.send('WebDriver:NewSession', { capabilities: {} });

let failures = 0;

for (const c of CASES) {
  await ff.send('WebDriver:Navigate', { url: c.url });
  await new Promise((r) => setTimeout(r, 7000));

  const src = unwrap(
    await ff.send('WebDriver:ExecuteScript', {
      script: `return {
        bPag: document.querySelectorAll('.b_pag').length,
        offMax: Math.max(0, ...[...document.querySelectorAll("a[href]")].map(a=>(a.getAttribute("href")||"").match(/[?&]first=(\d+)/)).filter(Boolean).map(m=>Number(m[1]))),
        bAlgo: document.querySelectorAll('li.b_algo').length,
      };`,
      args: [],
    }),
  );

  await ff.send('WebDriver:ExecuteScript', {
    script: `window.__cap = [];
      ['warn','error'].forEach(function (lv) {
        var o = console[lv];
        console[lv] = function () { window.__cap.push([].slice.call(arguments).join(' ')); o.apply(console, arguments); };
      });
      try { ${code} } catch (e) { window.__cap.push('THROW ' + String(e)); }
      return 1;`,
    args: [],
  });

  // 关键：等异步的 runner.start() 完成
  await new Promise((r) => setTimeout(r, 3500));

  const out = unwrap(
    await ff.send('WebDriver:ExecuteScript', {
      script: `return {
        pagRendered: document.querySelectorAll('.se-pagination .se-page').length,
        rootExists: !!document.getElementById('se-root'),
        resultCount: document.querySelectorAll('.se-item').length,
        currentTag: (document.querySelector('.se-page-current') || {}).tagName || null,
        // 页头菜单：inert 属性与弹出层在各浏览器表现不完全一致，一并检查
        menu: (function () {
          var btn = document.querySelector('.se-menu-btn');
          var popup = document.getElementById('se-menu-popup');
          if (!btn || !popup) return { exists: false };
          return {
            exists: true,
            label: (btn.textContent || '').trim(),
            sameRow: !!btn.closest('.se-brand-row'),
            closedHidden: getComputedStyle(popup).display === 'none',
            linkCount: popup.querySelectorAll('.se-menu-link').length,
            hrefsOk: Array.prototype.every.call(
              popup.querySelectorAll('.se-menu-link'),
              function (a) {
                return (a.getAttribute('href') || '').indexOf('http') === 0 &&
                  a.getAttribute('target') === '_blank';
              },
            ),
          };
        })(),
        links: (function () {
          var ls = document.querySelectorAll('.se-item .se-link');
          var hs = document.querySelectorAll('.se-item .se-hit');
          function cnt(arr, attr, val) {
            return Array.prototype.filter.call(arr, function (a) {
              return val ? a.getAttribute(attr) === val : !!a.getAttribute(attr);
            }).length;
          }
          return {
            linkTotal: ls.length,
            linkHref: cnt(ls, 'href'),
            linkBlank: cnt(ls, 'target', '_blank'),
            hitHref: cnt(hs, 'href'),
            hitBlank: cnt(hs, 'target', '_blank'),
          };
        })(),
        extra: (function () {
          var nodes = document.querySelectorAll('.se-extra');
          var hasRelated = false;
          nodes.forEach(function (n) {
            if (/相关搜索|Related searches/.test(n.textContent || '')) hasRelated = true;
          });
          return {
            count: nodes.length,
            hasRelatedSearch: hasRelated,
            leftoverRs: document.querySelectorAll('.se-extra .b_rs, .se-extra .rsExplr').length,
            leakedStyle: document.querySelectorAll('.se-extra style, .se-extra link').length,
          };
        })(),
        logs: (window.__cap || []).slice(0, 4),
      };`,
      args: [],
    }),
  );

  // 相关搜索不应出现在重写后的页面里
  const extraClean =
    !out.extra.hasRelatedSearch && out.extra.leftoverRs === 0 && out.extra.leakedStyle === 0;

  // 页头菜单：按钮与标题同行、收起时不显示、三个入口地址正确
  // （inert 属性与弹出层在各浏览器表现不完全一致，故一并检查）
  const menuOk =
    out.menu.exists &&
    out.menu.label === '菜单' &&
    out.menu.sameRow &&
    out.menu.closedHidden &&
    out.menu.linkCount === 3 &&
    out.menu.hrefsOk;

  // 标题锚点与整条锚点都必须有 href 且在新标签页打开
  const linkOk =
    out.links.linkTotal > 0 &&
    out.links.linkHref === out.links.linkTotal &&
    out.links.linkBlank === out.links.linkTotal &&
    out.links.hitHref === out.links.linkTotal &&
    out.links.hitBlank === out.links.linkTotal;

  // 原站无分页时（结果不足一页）不算失败
  const ok =
    (src.bPag > 0 ? out.pagRendered > 0 : out.rootExists) && extraClean && linkOk && menuOk;
  if (!ok) failures++;
  console.log(
    `${ok ? '✅' : '❌'} ${c.label}` +
      `  原站(分页容器=${src.bPag} 结果=${src.bAlgo})` +
      ` → 重写(分页=${out.pagRendered} 结果=${out.resultCount} 当前页=${out.currentTag})`,
  );
  console.log(
    `     链接: 标题 ${out.links.linkHref}/${out.links.linkTotal} 有 href、` +
      `${out.links.linkBlank} 新标签；整条 ${out.links.hitHref} 有 href、` +
      `${out.links.hitBlank} 新标签`,
  );
  console.log(
    `     菜单: ${out.menu.exists ? out.menu.label : '(缺失)'}` +
      ` 入口${out.menu.linkCount} 同行=${out.menu.sameRow} 收起隐藏=${out.menu.closedHidden}`,
  );
  console.log(
    `     直答区: ${out.extra.count} 个` +
      `  含相关搜索=${out.extra.hasRelatedSearch}` +
      `  残留b_rs=${out.extra.leftoverRs}` +
      `  泄漏样式=${out.extra.leakedStyle}`,
  );
  for (const l of out.logs ?? []) console.log(`     ${String(l).slice(0, 130)}`);
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 个用例失败`);
ff.end();
process.exit(failures === 0 ? 0 : 1);

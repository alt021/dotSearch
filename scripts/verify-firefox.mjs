/**
 * 用 Firefox（marionette 协议）验证分页提取在 Firefox 下是否有效。
 *
 * 背景：分页在 Chromium 下正常、Firefox 下不显示。
 * 本脚本以真实 Firefox 加载真实 Bing 页面，注入脚本后检查分页是否重建。
 *
 * 前置：先启动带 marionette 的 Firefox
 *   "C:/Program Files/Mozilla Firefox/firefox.exe" --headless --marionette --no-remote \
 *     --profile .build/ffprofile2 about:blank
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

// ---- 极简 marionette 客户端（长度前缀 JSON，Playwright 用的同一协议）----

/** marionette 返回值统一包在 { value } 里，这里解包 */
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
        const payload = JSON.stringify([0, id, name, params]);
        const body = Buffer.from(payload, 'utf8');
        sock.write(Buffer.concat([Buffer.from(`${body.length}:`, 'ascii'), body]));
      });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const colon = buf.indexOf(0x3a); // ':'
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

const ff = await connect();

// 握手
await ff.send('WebDriver:NewSession', { capabilities: {} });

// 真实 Bing 搜索页
const url = 'https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN&first=11';
await ff.send('WebDriver:Navigate', { url });

// 等待结果渲染
await new Promise((r) => setTimeout(r, 6000));

// 诊断 Firefox 解析后的分页 DOM
const diag = await ff.send('WebDriver:ExecuteScript', {
  script: `return (function () {
    var out = {};
    out.pagByClass = document.querySelectorAll('.b_pag').length;
    out.sbPagF = document.querySelectorAll('.sb_pagF').length;
    out.anchorsAria = document.querySelectorAll('a[aria-label^="第"]').length;
    var pag = document.querySelector('.b_pag');
    if (pag) {
      out.anchorsInPag = pag.querySelectorAll('a').length;
      out.childTags = Array.prototype.map.call(pag.children, function (c) {
        return c.tagName + '.' + (c.className || '');
      });
      out.parentTag = pag.parentElement ? pag.parentElement.tagName + '.' + (pag.parentElement.className||'') : null;
    }
    out.ua = navigator.userAgent.slice(0, 70);
    return out;
  })();`,
  args: [],
});
console.log('Firefox 诊断:', JSON.stringify(unwrap(diag), null, 2));

// 注入脚本（模拟 Tampermonkey）
const injected = await ff.send('WebDriver:ExecuteScript', {
  script: `globalThis.__SE_FORCE_ENGINE__ = 'bing'; ${code}; return true;`,
  args: [],
});
console.log('注入:', unwrap(injected));
await new Promise((r) => setTimeout(r, 2500));

// 注意：marionette 的 ExecuteScript 返回 { value: ... } 包装，需解包 .value
const check = unwrap(
  await ff.send('WebDriver:ExecuteScript', {
    script: `return (function () {
    return {
      rootExists: !!document.getElementById('se-root'),
      pagCount: document.querySelectorAll('.se-pagination .se-page').length,
      current: (document.querySelector('.se-page-current') || {}).textContent || null,
      currentTag: (document.querySelector('.se-page-current') || {}).tagName || null,
      resultCount: document.querySelectorAll('.se-item').length,
      pagHtml: (document.querySelector('.se-pagination') || {}).outerHTML ?
        document.querySelector('.se-pagination').outerHTML.slice(0, 300) : null,
    };
  })();`,
    args: [],
  }),
);
console.log('重写后:', JSON.stringify(check, null, 2));

const pass = check.rootExists && check.pagCount > 0 && check.resultCount > 0;
console.log(pass ? '\n✅ Firefox 验证通过：分页已显示' : '\n❌ Firefox 分页仍缺失');

ff.end();
process.exit(pass ? 0 : 1);

/**
 * 实时回归验证：在 Chromite 中打开**真实** Bing 搜索页，跑多个查询词。
 *
 * 与 verify-strip.mjs 的分工：
 *   verify-strip  离线快照 + 深度断言（用抓取下来的 HTML，不依赖网络）
 *   verify-live   真实站点 + 多查询词冒烟（依赖网络，覆盖真实 DOM 的差异）
 * 两者互补：快照测试能测细节但会随快照过期，实时测试能发现线上结构变化。
 *
 * 前置：先构建 dev 产物（npm run build:dev）。
 * 需要在沙箱外运行 —— 浏览器进程无法在沙箱内启动。
 *
 *   node scripts/verify-live.mjs                    直连，post-load 注入
 *   node scripts/verify-live.mjs --document-start    直连，document-start 注入
 *   node scripts/verify-live.mjs --proxy             走 7897 代理（→ www.bing.com）
 *   node scripts/verify-live.mjs --proxy --document-start   国际版 + document-start
 *
 * 关于必应的 IP 分流：直连落到 cn.bing.com（中国版），
 * 经代理落到 www.bing.com（国际版）。两版的 DOM 与脚本时序不同，
 * 国际版会做一次 `rdr=1` 重定向，历史上正是在这里出过启动即崩的故障，
 * 所以两种入口都要跑。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROFILE_DIR, launchChromitePersistent } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = readFileSync(join(root, 'dist/dev/search-enhance.user.js'), 'utf8');
// 去掉 UserScript 头部注释，只执行脚本主体（模拟 Tampermonkey 注入）
const code = bundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

const CASES = [
  { label: 'mozilla 第1页', url: 'https://www.bing.com/search?q=mozilla&setlang=zh-CN' },
  {
    label: '网络开发 第2页',
    url: 'https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN&first=11',
  },
  { label: '网络开发 第1页', url: 'https://www.bing.com/search?q=%E7%BD%91%E7%BB%9C%E5%BC%80%E5%8F%91&setlang=zh-CN' },
  { label: 'test 第1页', url: 'https://www.bing.com/search?q=test&setlang=zh-CN' },
  { label: 'rust 第1页', url: 'https://www.bing.com/search?q=rust&setlang=zh-CN' },
];

/*
 * 两个可选的运行模式（默认都不开，行为与以前一致）：
 *
 *   --proxy           走本机 7897 代理。用途：必应按 IP 分流 ——
 *                     直连落到 cn.bing.com（中国版），
 *                     经代理落到 www.bing.com（国际版）。
 *                     两版的 DOM 与脚本时序不同，需要分别验证。
 *
 *   --document-start  用 addInitScript 注入，精确模拟 Tampermonkey 的
 *                     @run-at document-start（脚本早于文档树执行）。
 *                     这是**必须**有的模式：post-load 注入测不到
 *                     「document.head / documentElement 还不存在」这类问题，
 *                     而线上恰恰就是这么挂的。
 */
const useProxy = process.argv.includes('--proxy');
const documentStart = process.argv.includes('--document-start');

const context = await launchChromitePersistent(PROFILE_DIR, {
  locale: 'zh-CN',
  viewport: { width: 1280, height: 1000 },
  ...(useProxy ? { proxy: { server: 'http://127.0.0.1:7897' } } : {}),
});
// 持久化上下文启动时已经带一个空白页，直接复用
const page = context.pages()[0] ?? (await context.newPage());

if (documentStart) {
  /*
   * 先补上 @grant 里声明的那几个 GM 接口 —— 真实 Tampermonkey 会提供它们。
   * 不补的话脚本会走原生回退路径，测的就不是用户的实际运行环境了。
   *
   * 存储桩挂在这个 context 上：同一 context 内的多个用例共用一份，
   * 与脚本管理器「脚本级存储」的语义一致（跨源共享）。
   * 每个新文档都要重新定义，所以放在 addInitScript 里而不是注入一次。
   */
  await context.addInitScript({
    content: `window.GM_addStyle = function (css) {
      var add = function () {
        var el = document.createElement('style');
        el.textContent = css;
        (document.head || document.documentElement).appendChild(el);
      };
      if (document.head) add();
      else document.addEventListener('DOMContentLoaded', add, { once: true });
      return null;
    };
    // 存储桩：值挂在 window 上，跨文档不保留（每个文档重新初始化），
    // 这对本脚本的验证目标是够的 —— 这里只关心重写与面板能否工作在
    // 「有 GM 存储」的环境下，跨源共享由 verify-strip 的专项段落覆盖。
    window.GM_getValue = function (key, fallback) {
      return key in window.__gmStore ? window.__gmStore[key] : fallback;
    };
    window.GM_setValue = function (key, value) {
      window.__gmStore[key] = value;
    };
    window.__gmStore = Object.create(null);`,
  });
  await context.addInitScript({ content: code });
}

const mode = [
  useProxy ? '代理 → www.bing.com' : '直连 → cn.bing.com',
  documentStart ? 'document-start 注入' : 'post-load 注入',
].join('，');
console.log(`模式：${mode}\n`);

/** 每个用例重置：只统计本用例产生的日志与报错 */
let captured = [];
let pageErrors = [];
let navs = [];
page.on('console', (m) => {
  if (m.type() !== 'warn' && m.type() !== 'error') return;
  const text = m.text();
  // 真实站点上会有大量与本项目无关的报错（Bing 自身的埋点校验请求失败等），
  // 只留本脚本的诊断，否则真正的线索会被噪音淹没。
  if (text.includes('[search-enhance]')) captured.push(text);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
// 记录主框架的导航：实测 Bing 会在页面就绪后再次导航（如 www → cn 的站点跳转），
// 重写好的 DOM 随旧文档一起消失，需要据此重注入
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) navs.push(f.url());
});

let failures = 0;

for (const c of CASES) {
  captured = [];
  pageErrors = [];
  navs = [];

  /*
   * 打开页面，容忍网络抖动。
   *
   * 经代理访问必应时偶发 `net::ERR_ABORTED`（代理侧断连或必应主动中止），
   * 属于环境噪声而非被测功能的问题 —— 重试一次即可，别让它把整个用例判死。
   */
  let navigated = false;
  for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      navigated = true;
    } catch (err) {
      if (attempt === 2) {
        failures++;
        console.log(`❌ ${c.label}  打开页面失败（网络/代理）：${String(err).slice(0, 90)}`);
      }
    }
  }
  if (!navigated) continue;

  await page.waitForSelector('li.b_algo', { timeout: 20_000 }).catch(() => {});

  // 注入前先记录原站状态，用于对照
  const src = await page
    .evaluate(() => ({
      bPag: document.querySelectorAll('.b_pag').length,
      bAlgo: document.querySelectorAll('li.b_algo').length,
    }))
    .catch(() => ({ bPag: 0, bAlgo: 0 }));

  // 页面未出结果时给出明确结论，避免后面一堆断言失败把人引向错误方向
  if (src.bAlgo === 0) {
    failures++;
    console.log(`❌ ${c.label}  页面未加载到结果（网络不可达？）`);
    continue;
  }

  /*
   * 注入脚本主体。
   *
   * post-load 模式（默认）用 evaluate + Function 构造器；
   * --document-start 模式下已经通过 addInitScript 挂在上下文上，
   * 每个新文档会自动执行，这里无需（也不该）再注入一次。
   *
   * 历史注记：早前这里的注释写着「addInitScript 会让 injectStyle 抛错，
   * 所以只能 post-load」—— 那其实是在绕开一个**真 bug**
   * （脚本在文档树建立前就访问 document.head/body）。
   * 该 bug 已修（见 core/env.ts、core/dom.ts），现在两种模式都可用，
   * 而 --document-start 正是能测出这类问题的模式。
   */
  const inject = () =>
    documentStart
      ? Promise.resolve()
      : page.evaluate((src2) => {
          // eslint-disable-next-line no-new-func
          new Function(src2)();
        }, code);

  /*
   * runner.start() 是异步的（内部要 await 结果容器出现），
   * 注入语句返回时脚本尚未跑完 —— 必须等根容器出现再检查，
   * 否则查到的分页数为 0 是测试假象（早期用固定 sleep 时踩过）。
   */
  const waitRoot = () =>
    page
      .waitForFunction(() => Boolean(document.getElementById('se-root')), null, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

  /*
   * 读状态。**必须容忍导航**：必应国际版在加载完成后还会做一次
   * `rdr=1` 重定向，此刻 evaluate 会抛
   * 「Execution context was destroyed」。
   * 这是测试替身遇到的正常现象（真实 Tampermonkey 会在新文档上自动重注入），
   * 不该让整个用例崩掉 —— 返回 null 让调用方跳过这一轮即可。
   */
  const state = () =>
    page
      .evaluate(() => ({
        root: Boolean(document.getElementById('se-root')),
        marked: Boolean(document.__searchEnhanceBing__),
      }))
      .catch(() => null);

  /*
   * 注入并确认产出，最多 3 轮。
   *
   * 为什么要重试：实测真实 Bing 偶发「注入后什么都没发生」以及
   * 「重写成功后又变回原站」—— 前者是注入的文档随二次导航一起消失，
   * 后者是在我们重写完成后 Bing 又导航了一次，重写的 DOM 随之丢弃。
   * 两种情况都表现为根容器不存在，判据统一用引擎的注入标记：
   *   标记不在 → 当前文档从未被注入 → 再注入一次
   *   标记在、根容器不在 → 脚本确实跑过但没产出，再注入会撞上
   *     「已注入则跳过」的保护，继续等没有意义 → 退出循环
   *
   * 注：真实使用中 Tampermonkey 会在每个新文档上自动注入，
   * 所以这两种情况对用户不可见 —— 是测试替身需要自己补上的一环。
   */
  let rooted = false;
  let injectCount = 0;
  /*
   * 轮询等根容器出现，**容忍中途导航**。
   *
   * 必应国际版加载完后还会做一次 `rdr=1` 重定向：重写好的 DOM 随旧文档消失，
   * 而新文档会因为 addInitScript（document-start 模式）自动再跑一遍脚本。
   * 所以这里不能「只等一轮」，要一直等到出现或超时。
   *
   * post-load 模式没有自动重注入，只能靠我们自己补：
   *   标记不在 → 当前文档从未被注入 → 再注入一次
   *   标记在、根容器不在 → 脚本跑过却没产出，再注入会撞上
   *     「已注入则跳过」的保护，继续等没有意义 → 退出
   */
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const st = await state(); // 导航中返回 null，跳过本轮即可
    if (st?.root) {
      rooted = true;
      break;
    }
    if (!documentStart) {
      if (st?.marked) break;
      await inject();
      injectCount++;
    }

    await waitRoot();
    // 稳定一小段再确认：期间若发生导航，重写好的 DOM 会随文档一起消失。
    // 这一段同时充当菜单、永页机桥接所需的稳定时间。
    await page.waitForTimeout(500);
    if ((await state())?.root) {
      rooted = true;
      break;
    }
  }

  // 仍未产出时打印现场，便于分辨是环境问题还是功能问题
  if (!rooted) {
    const probe = await page
      .evaluate(() => ({
        href: location.href,
        readyState: document.readyState,
        marked: Boolean(document.__searchEnhanceBing__),
        hasAlgo: document.querySelectorAll('li.b_algo').length,
      }))
      .catch(() => ({ href: '(导航中/取不到)' }));
    console.log(`   [未产出] ${JSON.stringify(probe)} 注入次数=${injectCount}`);
  } else if (injectCount > 1) {
    // 如实报告兜底被触发过，避免把「环境导致的重注入」看成一次干净通过
    console.log(`   [重注入] 共注入 ${injectCount} 次后产出；导航轨迹：`);
    for (const u of navs) console.log(`     → ${u}`);
  }

  /*
   * 采集重写后的现场。同样容忍导航：若此刻页面正在换文档，
   * 说明重写结果已随旧文档消失，本轮判失败并继续下一个用例，
   * 而不是让整个脚本崩掉。
   */
  const out = await page
    .evaluate(() => ({
      pagRendered: document.querySelectorAll('.se-pagination .se-page').length,
      rootExists: Boolean(document.getElementById('se-root')),
    resultCount: document.querySelectorAll('.se-item').length,
    currentTag: (document.querySelector('.se-page-current') || {}).tagName || null,
    menu: (() => {
      const btn = document.querySelector('.se-menu-btn');
      const popup = document.getElementById('se-menu-popup');
      if (!btn || !popup) return { exists: false };
      const entries = [...popup.querySelectorAll('.se-menu-link')];
      // 首个条目是本脚本自己的「结果过滤设置」，它是 <button> 而非 <a>
      const first = entries[0];
      const rest = entries.slice(1);
      return {
        exists: true,
        label: (btn.textContent || '').trim(),
        sameRow: Boolean(btn.closest('.se-brand-row')),
        closedHidden: getComputedStyle(popup).display === 'none',
        linkCount: entries.length,
        firstIsFilterButton:
          first?.tagName === 'BUTTON' &&
          (first.textContent || '').trim() === '结果过滤设置' &&
          !first.hasAttribute('href'),
        // 其余三个是原站入口替代品：必须有 http 地址且新标签打开
        hrefsOk: rest.every(
          (a) =>
            (a.getAttribute('href') || '').startsWith('http') &&
            a.getAttribute('target') === '_blank',
        ),
      };
    })(),
    links: (() => {
      const ls = [...document.querySelectorAll('.se-item .se-link')];
      const hs = [...document.querySelectorAll('.se-item .se-hit')];
      const count = (arr, attr, val) =>
        arr.filter((a) => (val ? a.getAttribute(attr) === val : Boolean(a.getAttribute(attr))))
          .length;
      return {
        linkTotal: ls.length,
        linkHref: count(ls, 'href'),
        linkBlank: count(ls, 'target', '_blank'),
        hitHref: count(hs, 'href'),
        hitBlank: count(hs, 'target', '_blank'),
      };
    })(),
    extra: (() => {
      const nodes = [...document.querySelectorAll('.se-extra')];
      return {
        count: nodes.length,
        hasRelatedSearch: nodes.some((n) => /相关搜索|Related searches/.test(n.textContent || '')),
        leftoverRs: document.querySelectorAll('.se-extra .b_rs, .se-extra .rsExplr').length,
        leakedStyle: document.querySelectorAll('.se-extra style, .se-extra link').length,
      };
    })(),
    /*
     * 命中测试覆盖：整页应当只有本脚本的内容能接收点击。
     *
     * 对应一个真实故障：重写把必应的样式表整体禁用后，
     * 必应塞进 body 的那些「零件」（浮层、遮罩、建议框容器）
     * 失去了原本约束它们的 CSS，可能以全屏遮罩的形态冒出来，
     * 把整页的点击都吃掉 —— 用户看到的就是「点什么都没反应」。
     *
     * 做法：在视口上打网格，统计落点在哪。
     * 落点只允许是本脚本内容，或 body/html（页面空白处的边距）。
     * 出现任何别的元素都算被遮挡。
     */
    coverage: (() => {
      const tally = { own: 0, blank: 0, foreign: [] };
      for (let y = 6; y < innerHeight; y += 24) {
        for (let x = 6; x < innerWidth; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          if (el.closest('#se-root')) tally.own++;
          else if (el === document.body || el === document.documentElement) tally.blank++;
          else {
            const key = `${el.tagName}${el.id ? '#' + el.id : ''}`;
            if (!tally.foreign.includes(key)) tally.foreign.push(key);
          }
        }
      }
      return tally;
    })(),
    }))
    .catch(() => null);

  if (!out) {
    failures++;
    console.log(`❌ ${c.label}  采集现场时页面正在导航，本轮作废（多为 rdr=1 重定向）`);
    continue;
  }

  // 相关搜索不应出现在重写后的页面里
  const extraClean =
    !out.extra.hasRelatedSearch && out.extra.leftoverRs === 0 && out.extra.leakedStyle === 0;

  // 没有任何原站元素挡在页面上（否则点击会被它吃掉）
  const uncovered = out.coverage.foreign.length === 0;

  // 页头菜单：按钮与标题同行、收起时不显示、入口完整
  const menuOk =
    out.menu.exists &&
    out.menu.label === '菜单' &&
    out.menu.sameRow &&
    out.menu.closedHidden &&
    // 4 项：结果过滤设置 + 账户 + Rewards + 搜索设置
    out.menu.linkCount === 4 &&
    out.menu.firstIsFilterButton &&
    out.menu.hrefsOk;

  // 标题锚点与整条锚点都必须有 href 且在新标签页打开
  const linkOk =
    out.links.linkTotal > 0 &&
    out.links.linkHref === out.links.linkTotal &&
    out.links.linkBlank === out.links.linkTotal &&
    out.links.hitHref === out.links.linkTotal &&
    out.links.hitBlank === out.links.linkTotal;

  /*
   * 结果过滤面板要真的能打开。
   *
   * 这一条对应一个真实故障：国际版（www.bing.com）上脚本在启动阶段就抛错，
   * 页面完全没有重写、菜单也不存在，用户看到的是「过滤面板点不开」。
   * 光断言菜单入口存在还不够 —— 必须实际走一遍
   * 「展开菜单 → 点过滤入口 → 面板出现」，把整条链路测穿。
   *
   * 这里用**程序化点击**（dispatchEvent / element.click）而不是合成鼠标。
   *
   * 原因：真实鼠标点击要求坐标精确落在元素上，而重写后的页面仍在被
   * 必应的脚本持续改动（实测它会往 body 里插 overlay-dimmer 之类的节点），
   * 测量与按下之间只要漂移几像素，小到 27x19 的菜单按钮就会点空 ——
   * 这属于测试替身的脆弱，不是被测功能的问题，会干扰对真实故障的判断。
   *
   * 输入层（遮挡、命中测试、pointer-events）由下面的 `命中覆盖` 断言负责，
   * 那条才是针对「整页点不动」的有效守护。
   */
  const panel = await page.evaluate(() => {
    const btn = document.querySelector('.se-menu-btn');
    if (!btn) return { step: 'no-menu-button' };
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const popup = document.getElementById('se-menu-popup');
    const menuOpen = popup ? !popup.hasAttribute('inert') : false;
    const entry = document.querySelector('#se-menu-popup .se-menu-filter');
    if (!entry) return { step: 'no-filter-entry', menuOpen };
    entry.click();
    const panelEl = document.querySelector('.se-filter-panel');
    if (!panelEl) return { step: 'panel-not-opened', menuOpen };
    const rect = panelEl.getBoundingClientRect();
    return {
      step: 'opened',
      menuOpen,
      visible: rect.width > 0 && rect.height > 0,
      hasRows: !!document.querySelector('.se-filter-rows'),
    };
  });
  const panelOk = panel.step === 'opened' && panel.menuOpen && panel.visible && panel.hasRows;

  // 原站无分页时（结果不足一页）不算失败
  const ok =
    (src.bPag > 0 ? out.pagRendered > 0 : out.rootExists) &&
    extraClean &&
    uncovered &&
    linkOk &&
    menuOk &&
    panelOk;
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
      ` 入口${out.menu.linkCount} 同行=${out.menu.sameRow} 收起隐藏=${out.menu.closedHidden}` +
      ` 首项为过滤按钮=${out.menu.firstIsFilterButton}`,
  );
  console.log(
    `     过滤面板: ${panel.step}` +
      (panel.step === 'opened' ? ` 可见=${panel.visible} 列表=${panel.hasRows}` : ''),
  );
  console.log(
    `     命中覆盖: 本脚本 ${out.coverage.own} 点 / 空白 ${out.coverage.blank} 点` +
      (uncovered ? '，无原站元素遮挡' : `，被遮挡：${out.coverage.foreign.join(', ')}`),
  );
  console.log(
    `     直答区: ${out.extra.count} 个` +
      `  含相关搜索=${out.extra.hasRelatedSearch}` +
      `  残留b_rs=${out.extra.leftoverRs}` +
      `  泄漏样式=${out.extra.leakedStyle}`,
  );
  // 脚本自身的诊断日志：失败时最有用的线索
  for (const l of captured.slice(0, 4)) console.log(`     ${String(l).slice(0, 130)}`);
  for (const e of pageErrors.slice(0, 2)) console.log(`     [页面报错] ${e.slice(0, 130)}`);
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 个用例失败`);

await context.close();
process.exit(failures === 0 ? 0 : 1);

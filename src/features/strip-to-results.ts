import type { Feature } from '../types/feature.js';
import type { EngineAdapter, SearchResult } from '../types/engine.js';
import { log } from '../core/env.js';

/**
 * 结果页重写：把 Bing 结果页替换为「搜索框 + 干净的结果列表」。
 *
 * 与「删掉多余元素、留下原站 DOM」的做法不同，这里**不复用任何原站结果节点**：
 * 先用 EngineAdapter 把结果解析成结构化数据，再从零构建 DOM。
 * 理由：
 *   - 原站节点的 class 与冗余包裹层在换掉 CSS 后毫无意义，只会污染后续样式
 *   - 重建后的 DOM 完全可控，视觉重设计不受原站结构束缚
 *   - 结果已结构化（标题/摘要/真实 URL/来源），后续做排序、过滤、去广告都很直接
 *
 * 副作用：原站搜索框随 #b_header 一起消失，其 pushState 换词机制随之失效。
 * 因此必须补一个搜索框，并用整页跳转（location.assign）提交，
 * 保证每次搜索都能重新触发本脚本。
 */

/** 需要保留的非结果内容 */
const EXTRA_SELECTORS = {
  /**
   * 分页控件。
   *
   * 注意是 **class** 而非 id —— 实测 Bing 渲染为
   * `<li class="b_pag"><nav><ul class="sb_pagF"><li><a>…</a></li></ul></nav></li>`，
   * 不存在 id="b_pag"。用 #b_pag 永远匹配不到。
   *
   * 该 <li> 内首个子元素是 <link rel="stylesheet">，且其所在 <ol> 存在
   * 提前闭合（</ol></main>）——这类非标准嵌套在 Chromium 与 Firefox 中
   * 解析结果不同，因此**不能用后代选择器**（如 .b_pag .sb_pagF a），
   * 必须先用 querySelectorAll('.b_pag') 定位容器、再各自查询内部，
   * 避免跨浏览器的结构差异导致匹配失败。
   */
  pagination: '.b_pag',
  /** 顶部直答区：结构复杂，仅保留原节点 */
  answer: '#b_context .b_ans',
} as const;

/** 重建后的根容器 id，便于样式与后续功能定位 */
export const ROOT_ID = 'se-root';

export const stripToResults: Feature = {
  id: 'strip-to-results',
  name: '重写结果页',
  description: '移除顶栏、页脚、侧栏、广告与原站样式，用统一结构重建结果列表。',
  engines: 'all',
  defaultEnabled: true,

  supports() {
    return true;
  },

  /**
   * 判断当前已改写的页面是否需要重新执行。
   *
   * 背景：Firefox 从 bfcache 恢复页面时，改写后的 DOM 会一并被恢复，
   * 但原站内容完整性不保证 —— 典型表现是分页导航消失。
   *
   * 判据：页面上若无分页导航，但原站此刻又能提取到分页，
   * 说明改写结果已不完整，应当重建。
   * 若原站本就没有分页（结果不足一页），则不算异常，保持现状。
   */
  needsRebuild() {
    const rendered = document.querySelector('.se-pagination');
    if (rendered) return false; // 分页在，状态完整
    // 页面上没有分页，看原站是否具备分页可供提取
    const source = extractPaginationLinks();
    return source.length > 0;
  },

  async onNavigate({ engine, query }) {
    // 幂等保护：Runner 已通过 needsRebuild 决定是否执行，
    // 若根容器仍在说明无需重建，直接返回。
    if (document.getElementById(ROOT_ID)) {
      log.info('页面已重写且状态完整，跳过');
      return;
    }

    const before = document.body.querySelectorAll('*').length;
    const container = document.querySelector(engine.resultContainerSelector);
    if (!container) {
      // 原站结果容器不存在（bfcache 恢复后可能已被清空），
      // 此时重建只会得到空白页，保持现状并告警。
      log.warn(`结果容器未找到（${engine.resultContainerSelector}），无法重写`);
      return;
    }

    /*
     * 关键：分页通常晚于结果容器渲染。
     * 早期版本等到 #b_results 就立即提取分页，此时分页尚未生成，
     * 提取为 0 → 触发「补齐第 1 页」→ 页面上只剩一个孤立的「1」。
     * 这正是「原本 3 页只显示 1 页」的原因。
     * 故在此短暂等待分页线索出现（拿到即返回，无分页时才等满超时）。
     */
    await waitForPagination(1_000);

    // ---- 1. 解析结果为结构化数据（必须在清空 DOM 之前完成）---------------
    const results = engine.extractResults(container);
    const pages = extractPaginationLinks();

    /*
     * 诊断信息必须在清空 DOM **之前**采集。
     * 早前版本把探测放在清空之后，counts 恒为 0，等于没打印。
     */
    const hrefFirstCount = document.querySelectorAll('a[href*="first="]').length;
    const pagProbe =
      `a[href*=first]=${hrefFirstCount} ` +
      `.b_pag=${document.querySelectorAll('.b_pag').length} ` +
      `.sb_pagF=${document.querySelectorAll('.sb_pagF').length} ` +
      `aria[第/Page]=${document.querySelectorAll('a[aria-label^="第"], a[aria-label^="Page"]').length}`;

    // 直答区结构复杂，仅保留原节点
    const answerNode = document.querySelector(EXTRA_SELECTORS.answer);

    // 直答区是唯一会保留到新页面的原站节点，
    // 其内部常混入备案号、隐私政策、条款等合规链接，需先剔除
    if (answerNode) stripComplianceLinks(answerNode as HTMLElement);

    // ---- 2. 清空页面 -------------------------------------------------------
    document.body.innerHTML = '';
    document.body.className = 'se-stripped';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.className = 'se-root-html';

    // ---- 3. 重建结构 -------------------------------------------------------
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.query = query;

    // 页头：瑞士风格以「元信息块 + 粗规则线」建立页面起点。
    // 页头内的大标题同时承担搜索输入职责，不再另设搜索框。
    root.appendChild(buildMasthead(query, results.length, engine));

    const main = document.createElement('main');
    main.className = 'se-main';

    if (answerNode) {
      answerNode.classList.add('se-extra');
      main.appendChild(answerNode);
    }

    if (results.length > 0) {
      main.appendChild(buildResultList(results));
      if (pages.length > 0) {
        main.appendChild(buildPagination(pages));
      } else {
        /*
         * 分页缺失告警。分两种情况，处置方式不同：
         *   a[href*=first]=0 → 原站本就没有分页（结果不足一页），属正常
         *   a[href*=first]>0 → 提取逻辑失效，需要排查
         * 故把候选链接一并打印，便于直接定位。
         */
        const candidates = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href*="first="]'),
        )
          .slice(0, 8)
          .map((a) => `"${(a.textContent ?? '').trim().slice(0, 12)}"`)
          .join(', ');
        log.warn(
          `[分页缺失] 提取 0 项。清空前探测：${pagProbe}` +
            (candidates ? ` 候选：${candidates}` : ' 无候选（该页可能本就没有分页）'),
        );
      }
    } else {
      main.appendChild(buildEmptyState(query));
    }

    root.appendChild(main);
    document.body.appendChild(root);

    // 补上依赖动态状态的一小段规则；主体样式由 Runner 统一注入
    const style = document.createElement('style');
    style.id = 'se-rewrite-style';
    style.textContent = 'html.se-root-html { height: auto; }';
    document.head.appendChild(style);

    const after = document.body.querySelectorAll('*').length;
    // 用 warn 级别输出关键诊断：Firefox 默认会显示 console.warn，
    // 而 console.info 需开启调试等级才可见，跨浏览器排查时容易看不到。
    log.warn(
      `[重写完成] DOM ${before} → ${after}，结果 ${results.length} 条，` +
        `分页 ${pages.length} 项（${lastPaginationDebug}）`,
    );
  },
};

/**
 * 构建页头。
 *
 * 瑞士风格典型的杂志式页头：刊名式标识 + 查询词 + 统计信息，
 * 底部以粗规则线收束，替代任何色块或阴影装饰。
 *
 * 查询词本身即是搜索输入：点击即可编辑，按 Enter 发起搜索。
 * 因此页头不再另设独立搜索框，避免同一页面出现两个搜索入口。
 */
function buildMasthead(query: string, count: number, engine: EngineAdapter): HTMLElement {
  const head = document.createElement('header');
  head.className = 'se-masthead';

  const brand = document.createElement('p');
  brand.className = 'se-brand';
  // 用强调色方块作为唯一点缀，呼应瑞士国旗
  const mark = document.createElement('span');
  mark.className = 'se-mark';
  mark.setAttribute('aria-hidden', 'true');
  brand.append(mark, document.createTextNode(`${engine.name} — 检索`));
  head.appendChild(brand);

  // 查询词作为可编辑输入：大字号标题样式，回车即搜索
  const form = document.createElement('form');
  form.className = 'se-query-form';
  form.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'se-query';
  input.value = query;
  input.setAttribute('aria-label', '搜索关键词');
  input.spellcheck = false;
  input.autocomplete = 'off';
  // 点击页面其他区域时会失焦，避免残留的原生选中高亮影响观感
  input.addEventListener('blur', () => input.setSelectionRange(0, 0));

  const stat = document.createElement('p');
  stat.className = 'se-stat';
  // 默认显示结果数；进入编辑态后改为提示回车提交
  stat.textContent = `找到 ${count} 条结果`;

  form.append(input, stat);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword || keyword === query) return;
    const { path, param } = engine.searchForm;
    window.location.assign(
      `${window.location.origin}${path}?${param}=${encodeURIComponent(keyword)}`,
    );
  });

  // 聚焦时切换提示文案，让用户知道回车可用
  input.addEventListener('focus', () => {
    stat.textContent = '按回车键发起搜索';
  });

  // 失焦立即还原：舍弃用户对该标题的全部改动
  input.addEventListener('blur', () => {
    input.value = query;
    stat.textContent = `找到 ${count} 条结果`;
  });

  head.appendChild(form);
  return head;
}

/** 构建结果列表 */
function buildResultList(results: SearchResult[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'se-list';

  results.forEach((result, i) => {
    const item = document.createElement('li');
    item.className = 'se-item';

    // 左栏：序号。瑞士风格用等宽数字建立纵向韵律，替代装饰性图形
    const num = document.createElement('span');
    num.className = 'se-num';
    num.textContent = String(i + 1).padStart(2, '0');

    // 右栏：内容
    const body = document.createElement('div');
    body.className = 'se-body';

    // 来源：置于标题之上，用等宽小字，是瑞士风格典型的元信息前置手法
    if (result.displayUrl) {
      const cite = document.createElement('cite');
      cite.className = 'se-cite';
      cite.textContent = result.displayUrl;
      body.appendChild(cite);
    }

    const heading = document.createElement('h2');
    heading.className = 'se-title';
    const anchor = document.createElement('a');
    anchor.className = 'se-link';
    anchor.textContent = result.title || result.displayUrl || '(无标题)';
    heading.appendChild(anchor);
    body.appendChild(heading);

    if (result.snippet) {
      const desc = document.createElement('p');
      desc.className = 'se-snippet';
      desc.textContent = result.snippet;
      body.appendChild(desc);
    }

    // 整条可点击：用一个覆盖整栏的「stretched link」透明锚点。
    // 相比给整块包 <a>，这种方式保留了标题内独立的语义化链接
    // （利于中键新标签、复制链接、右键菜单），且不影响内部文本选择。
    const href = result.url ?? result.link?.href;
    if (href) {
      const hit = document.createElement('a');
      hit.className = 'se-hit';
      hit.href = href;
      hit.setAttribute('aria-hidden', 'true');
      hit.tabIndex = -1;
      item.append(num, hit, body);
    } else {
      item.append(num, body);
    }

    list.appendChild(item);
  });

  return list;
}

/** 一页分页项 */
interface PageLink {
  /** 显示文本 */
  label: string;
  /** 目标地址；当前页为 null */
  href: string | null;
  /** 无障碍标签（如「第 2 页」） */
  ariaLabel: string;
  /** 是否为当前所在页 */
  current: boolean;
}

/*
 * ============ 分页提取 ============
 *
 * ## 为什么不能依赖原站的分页 DOM
 *
 * 换过三轮判据都失败了：
 *   1. 后代选择器 .b_pag .sb_pagF a  → Firefox 解析差异导致失配
 *   2. .b_pag 容器 + aria-label       → 用户页面上两者都不存在
 *   3. a[href*="first="]              → 翻页链接可能无 href（JS 驱动）
 *
 * 根本教训：分页的 DOM 结构、class 名、aria-label 文案，甚至「有没有
 * href」，都随语言 / 地区 / 布局 / A-B 实验而变，都不是可靠判据。
 *
 * ## 现方案：只读取「有几页」，链接自己构造
 *
 * 唯一跨场景稳定的信息是 first= 这个结果偏移量
 * （第 N 页 = first=(N-1)*10+1）。它同时出现在：
 *   - 翻页链接的 href 里
 *   - 页面内联脚本的配置数据里
 *
 * 因此从「DOM 链接」与「整份 HTML」两处收集偏移量，推出最大页数，
 * 再用当前 URL 自己拼出每一页的地址。
 * 这样即使原站链接完全不可用，分页依然可用。
 */

/** 从 URL 串中提取 first= 偏移量 */
const FIRST_PARAM_RE = /[?&]first=(\d+)/g;

/** 分页可能出现的容器，用于等待其渲染完成 */
export const PAGINATION_HINT_SELECTOR = '.b_pag, .sb_pagF, .sb_pag, a[href*="first="]';

/** 单页结果数（Bing 默认 10）；由偏移量差值自动校正 */
const DEFAULT_PAGE_SIZE = 10;

/** 页码上限，避免异常数据撑爆版面 */
const MAX_PAGE_COUNT = 50;

/**
 * 等待分页线索出现（分页常晚于结果容器渲染）。
 *
 * 已存在则立即返回；否则用 MutationObserver 监听，出现即返回；
 * 超时后返回（原站本就没有分页时属正常情况）。
 * 之所以用观察而非固定 sleep，是为了不无谓拖慢重写速度。
 */
function waitForPagination(timeout: number): Promise<void> {
  if (document.querySelector(PAGINATION_HINT_SELECTOR)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer = 0;

    // 先声明观察者，finish 中才能安全引用（函数声明会提升）
    const observer = new MutationObserver(() => {
      if (document.querySelector(PAGINATION_HINT_SELECTOR)) finish();
    });

    function finish(): void {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve();
    }

    timer = window.setTimeout(finish, timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

/** 收集页面中出现的所有 first= 偏移量 */
function collectPageOffsets(): number[] {
  const offsets = new Set<number>();

  // 来源 1：带 first= 的翻页链接（最可靠）
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const raw = a.getAttribute('href') ?? '';
    // 带 g 标志的正则是有状态的，复用前必须重置 lastIndex
    FIRST_PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FIRST_PARAM_RE.exec(raw))) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) offsets.add(n);
    }
  }

  // 来源 2：整份 HTML 兜底，覆盖 onclick / 内联脚本 / 非 a 元素。
  // 仅在来源 1 无收获时启用，避免把无关参数误当页码。
  if (offsets.size === 0) {
    const html = document.documentElement.innerHTML;
    FIRST_PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FIRST_PARAM_RE.exec(html))) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) offsets.add(n);
    }
  }

  return [...offsets].filter((n) => n >= 1).sort((a, b) => a - b);
}

/** 由偏移量差值推断每页条数（Bing 默认 10，但可被参数改变） */
function detectPageSize(offsets: number[]): number {
  // 相邻偏移量之差即每页条数；取最小正值以兼容不连续的偏移集合
  const diffs: number[] = [];
  for (let i = 1; i < offsets.length; i++) {
    const prev = offsets[i - 1];
    const cur = offsets[i];
    if (prev === undefined || cur === undefined) continue;
    const d = cur - prev;
    if (d > 0) diffs.push(d);
  }
  return diffs.length > 0 ? Math.min(...diffs) : DEFAULT_PAGE_SIZE;
}

/** 第 1 页为 1；URL 不带 first= 即第 1 页 */
function currentPageNumber(pageSize: number): number {
  const raw = new URL(location.href).searchParams.get('first');
  const offset = raw === null ? 1 : Number(raw);
  if (!Number.isFinite(offset) || offset <= 1) return 1;
  return Math.floor((offset - 1) / pageSize) + 1;
}

/*
 * 偏移量 → 页码。
 *
 * 实测 Bing 的 first= 存在两种约定，同一站点不同渲染都可能出现：
 *   1-based：第 2 页 first=11、第 3 页 first=21（每页 10 条）
 *   0-based：第 2 页 first=10、第 3 页 first=20（每页 10 条）
 * 用 floor(offset / pageSize) + 1 可同时覆盖两者：
 *   floor(11/10)+1 = 2 ✓   floor(21/10)+1 = 3 ✓
 *   floor(10/10)+1 = 2 ✓   floor(20/10)+1 = 3 ✓
 * 若写成 floor((offset-1)/pageSize)+1，0-based 情形会少算一页。
 */
function offsetToPage(offset: number, pageSize: number): number {
  return Math.floor(offset / pageSize) + 1;
}

/** 页码 → 偏移量（生成链接时用 1-based，Bing 两种约定都接受） */
function pageToOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize + 1;
}

/**
 * 读取原站**渲染出来的页码数字**。
 *
 * 这是最权威的页数来源：翻页链接自身的文本就写着「2」「3」，
 * 直接采信即可，无需从偏移量反推，避免偏移约定差异导致的偏差。
 */
function collectRenderedPageNumbers(): number[] {
  const nums = new Set<number>();

  for (const a of document.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = a.getAttribute('href') ?? '';
    const text = (a.textContent ?? '').trim();
    const aria = (a.getAttribute('aria-label') ?? '').trim();

    // 页码文案：纯数字文本，或「第 N 页」/「Page N」
    let numText: string | undefined;
    if (/^\d{1,3}$/.test(text)) {
      numText = text;
    } else {
      const m = aria.match(/^第\s*(\d{1,3})\s*页$/) ?? aria.match(/^Page\s*(\d{1,3})$/i);
      numText = m?.[1];
    }
    if (!numText) continue;

    /*
     * 必须确认这是分页链接，否则会把「10 条结果」之类的数字误当页码。
     * 判据：带 first= 参数，或位于分页容器内。
     */
    const paginated =
      /[?&]first=\d+/.test(href) ||
      a.closest('.b_pag, .sb_pagF, .sb_pag, nav[aria-label], nav[role="navigation"]') !== null;
    if (!paginated) continue;

    const n = Number(numText);
    if (n >= 1 && n <= 999) nums.add(n);
  }

  return [...nums].sort((a, b) => a - b);
}

/** 基于当前 URL 构造第 page 页的地址 */
function buildPageHref(base: URL, page: number, pageSize: number): string {
  const url = new URL(base.href);
  if (page <= 1) {
    // 第 1 页是默认值，去掉参数让地址更干净
    url.searchParams.delete('first');
  } else {
    url.searchParams.set('first', String(pageToOffset(page, pageSize)));
  }
  return url.href;
}

/** 上一次分页提取的诊断描述，供完成日志输出 */
let lastPaginationDebug = '';

/**
 * 最后的兜底：从分页容器里的纯数字元素推断总页数。
 *
 * 用于「翻页链接由 JS 驱动、没有 href，因而不含 first=」的布局。
 * 仅作为没有偏移量线索时的替代方案，优先级最低。
 */
function collectNumericPageHints(): number[] {
  const nums = new Set<number>();
  const scopes = document.querySelectorAll(
    '.b_pag, .sb_pagF, .sb_pag, nav[aria-label], nav[role="navigation"]',
  );
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('a, span, div, li')) {
      const t = (el.textContent ?? '').trim();
      // 只看纯数字，且排除三位以上（避免把年份等数据误认成页码）
      if (/^\d{1,3}$/.test(t)) nums.add(Number(t));
    }
  }
  return [...nums];
}

/** 提取分页。返回空数组表示该页确实没有分页
 * （结果不足一页，或原站未提供任何翻页线索）。
 */
function extractPaginationLinks(): PageLink[] {
  const offsets = collectPageOffsets();
  const pageSize = detectPageSize(offsets);
  const base = new URL(location.href);
  const current = currentPageNumber(pageSize);

  /*
   * 总页数按优先级推断，取各来源的最大值（偏保守，漏页比多页干扰小）：
   *   1. 原站渲染出的页码数字 —— 最权威，直接写着「2」「3」
   *   2. first= 偏移量反推 —— 覆盖页码文字非数字的情形
   *   3. 分页容器内的纯数字 —— 覆盖链接无 href 的 JS 驱动布局
   */
  const renderedPages = collectRenderedPageNumbers();
  const fromOffsets =
    offsets.length > 0 ? offsetToPage(Math.max(...offsets), pageSize) : 0;
  const numericHints =
    renderedPages.length > 0 || fromOffsets > 0 ? [] : collectNumericPageHints();

  let maxPage = Math.max(
    current,
    renderedPages.length > 0 ? Math.max(...renderedPages) : 0,
    fromOffsets,
    numericHints.length > 0 ? Math.max(...numericHints) : 0,
  );

  // 完全没有任何线索：原站该页确实没有分页
  if (maxPage <= 1 && renderedPages.length === 0 && fromOffsets === 0) {
    lastPaginationDebug = '无分页线索（结果可能不足一页）';
    return [];
  }

  maxPage = Math.min(maxPage, MAX_PAGE_COUNT);

  lastPaginationDebug =
    `页码[${renderedPages.join(',') || '-'}] ` +
    `偏移[${offsets.join(',') || '-'}] 每页${pageSize}条 ` +
    `当前第${current}页 总${maxPage}页`;

  const pages: PageLink[] = [];
  for (let n = 1; n <= maxPage; n++) {
    const isCurrent = n === current;
    pages.push({
      label: String(n),
      // 当前页不给链接（渲染为 span，语义上不可点）
      href: isCurrent ? null : buildPageHref(base, n, pageSize),
      ariaLabel: `第 ${n} 页`,
      current: isCurrent,
    });
  }

  return pages;
}

/** 构建分页导航 */
function buildPagination(pages: PageLink[]): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'se-pagination';
  nav.setAttribute('aria-label', '分页');

  for (const page of pages) {
    if (page.current) {
      // 当前页用 <span>，保持语义正确（不可点击的当前页不应是链接）
      const cur = document.createElement('span');
      cur.className = 'se-page se-page-current';
      cur.textContent = page.label;
      cur.setAttribute('aria-current', 'page');
      cur.setAttribute('aria-label', page.ariaLabel);
      nav.appendChild(cur);
      continue;
    }

    const link = document.createElement('a');
    link.className = 'se-page';
    link.href = page.href ?? '#';
    link.textContent = page.label;
    link.setAttribute('aria-label', page.ariaLabel);
    nav.appendChild(link);
  }

  return nav;
}


/** 无结果时的占位提示 */
function buildEmptyState(query: string): HTMLElement {
  const empty = document.createElement('p');
  empty.className = 'se-empty';
  empty.textContent = `没有找到与「${query}」相关的结果。`;
  return empty;
}

/** 判定链接文案是否属于备案 / 隐私 / 条款等合规信息 */
const COMPLIANCE_PATTERN =
  /隐私|条款|条款|协议|备案|许可|版权|法律|声明|政策|服务条款|隐私政策|隐私声明|京 ICP|沪 ICP|粤 ICP|ICP 备|公网安备|copyright|privacy|terms|legal|cookie/i;

/**
 * 移除节点内的备案 / 隐私 / 条款等合规链接。
 *
 * 背景：重写后页面理论上已无这些内容，但直答区（#b_context .b_ans）
 * 是唯一保留的原站节点，其内部常混入此类链接，
 * 会在纯结果列表里显得突兀，故显式剔除。
 */
function stripComplianceLinks(root: HTMLElement): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const href = a.getAttribute('href') ?? '';
    if (COMPLIANCE_PATTERN.test(text) || COMPLIANCE_PATTERN.test(href)) {
      // 优先删整个包裹元素，避免留下空白段落
      const block = a.closest('li, p, div') ?? a;
      block.remove();
    }
  });
}

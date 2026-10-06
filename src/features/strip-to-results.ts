import type { Feature } from '../types/feature.js';
import type { EngineAdapter, SearchResult } from '../types/engine.js';
import { log, reassertOwnStyle } from '../core/env.js';
import { captureBingSession } from './bing-session.js';
import { getRules, matchRule, type FilterRule } from './filter-store.js';

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
  /**
   * 直答区候选。
   *
   * 实测 `#b_context` 是右侧栏「更多结果」的容器，
   * 其下的 `<li class="b_ans">` 既可能承载真正的直答模块，
   * **也可能只是「相关搜索」**(`<div class="b_rs rsExplr">`)，后者不应保留。
   * 因此这里只做候选收集，由 pruneAnswerNodes() 逐个甄别。
   */
  answer: '#b_context .b_ans',
} as const;

/**
 * 「相关搜索」模块的识别特征。
 *
 * 实测 Bing 渲染为 `<div class="b_rs rsExplr">`，
 * 文案形如「网络开发 的相关搜索 …」。
 * 用户明确表示不要这个模块，故保留直答区时须剔除。
 */
function isRelatedSearchBlock(el: Element): boolean {
  // 类名判定为主（稳定），文案判定为辅（兜底）
  const classes = String(el.className ?? '').split(/\s+/);
  if (classes.includes('b_rs') || classes.includes('rsExplr')) return true;

  // 仅当文案以「相关搜索」这类标题开头时才判定，避免误伤正文里的同名词
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return /^(相关搜索|Related searches|人们还搜索了|其他人还搜了|People also search)/i.test(text);
}

/** 重建后的根容器 id，便于样式与后续功能定位 */
export const ROOT_ID = 'se-root';

/**
 * 页头里预留给菜单的挂载点类名。
 * tool-menu 功能据此找到落点，避免与页头实现细节耦合。
 */
export const MENU_SLOT_CLASS = 'se-menu-slot';

/**
 * 原站内容的隐藏容器 id。
 *
 * 重写时把必应原有 DOM 整体搬进这里而非删除：
 * 自动翻页脚本（东方永页机）需要靠原有结构定位下一页与插入点，
 * 而 pagetual-bridge 也要从这里采出新加载的结果。
 */
export const SOURCE_ID = 'se-source';

/**
 * 结果列表容器 id。
 * 过滤设置改动后按此定位列表整表重建。
 */
export const LIST_ID = 'se-list';

/** 缓存本次重写时的解析结果，供过滤规则变化后重建列表 */
let lastSearchResults: SearchResult[] = [];

/**
 * 按当前过滤规则重建整个结果列表。
 *
 * 由设置面板在规则变化后调用。之所以整表重建而不是就地打补丁：
 * 过滤规则是全局性的 —— 改一条规则可能影响任意条目，
 * 且隐藏态会把条目降级（删摘要、摘链接），恢复时又得拼回去。
 * 逐个打补丁的状态机远比重建复杂，也更容易留下不一致。
 *
 * @returns 是否有可重建的列表（false 表示当前页面没有结果列表）
 */
export function rerenderResults(): boolean {
  const list = document.getElementById(LIST_ID);
  if (!list || lastSearchResults.length === 0) return false;

  const rules = getRules();
  list.textContent = '';
  list.append(...buildResultItems(lastSearchResults, 0, rules));
  log.info(`已按 ${rules.length} 条过滤规则重建列表`);
  return true;
}

/**
 * 当前页面上实际可见（未被隐藏）的结果条数。
 * 页头统计用得上，也便于验证脚本断言。
 */
export function countVisibleResults(): number {
  return document.querySelectorAll('.se-item:not(.se-item-hidden)').length;
}

/**
 * 把 body 现有内容整体移入隐藏容器。
 *
 * 用 appendChild 逐个搬移（而非克隆或 innerHTML 赋值）：
 * - 搬移会保留节点上已绑定的事件监听，必应脚本与 Pagetual 的引用继续有效
 * - innerHTML 赋值会重建节点，等于把别人的监听全清掉
 *
 * 容器本身由 CSS 设为「absolutely positioned + 1px + overflow hidden +
 * contain: paint」：不可见、不占位，且固定定位后代会一并被裁掉。
 */
function clipOriginalContent(): HTMLElement {
  const source = document.createElement('div');
  source.id = SOURCE_ID;
  source.className = 'se-source';
  // 对辅助技术隐藏，并移出焦点顺序
  source.setAttribute('aria-hidden', 'true');
  source.toggleAttribute('inert', true);

  while (document.body.firstChild) source.appendChild(document.body.firstChild);
  document.body.appendChild(source);
  return source;
}

export const stripToResults: Feature = {
  id: 'strip-to-results',
  name: '重写结果页',
  description: '移除顶栏、页脚、侧栏、广告与原站样式，用统一结构重建结果列表。',
  engines: 'all',

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

    /*
     * 直答区：逐个甄别后再保留。
     * 该节点是唯一会保留到新页面的原站内容，需做三项清理：
     *   1. 剔除「相关搜索」模块（用户明确不需要）
     *   2. 剔除内联 <style>/<link>，否则原站 CSS 会泄漏进改写后的页面
     *   3. 剔除备案号、隐私政策等合规链接
     * 清理后若已无实质内容，则整体丢弃，不留空壳。
     */
    /*
     * 必应会话状态也必须在清空前采集：
     * 判据来自顶栏（#id_a / #id_l / #id_p），而顶栏正是被本功能清掉的。
     * 右侧工具栏在页面重建后才挂载，那时已无从读取，
     * 故在此取一次并缓存，供其使用。
     */
    captureBingSession();

    const answerNodes = Array.from(
      document.querySelectorAll<HTMLElement>(EXTRA_SELECTORS.answer),
    ).filter((node) => pruneAnswerNode(node));

    // ---- 2. 先把新页面整个建好（纯内存操作，尚未触碰原站页面）--------------
    //
    // 顺序上刻意「先构建、后提交」（提交段见下方 4.）：
    // 构建要拼几十个节点，任何一步抛错都不该把用户页面弄残。
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.query = query;

    // 页头：瑞士风格以「元信息块 + 粗规则线」建立页面起点。
    // 页头内的大标题同时承担搜索输入职责，不再另设搜索框。
    root.appendChild(buildMasthead(query, results.length, engine));

    const main = document.createElement('main');
    main.className = 'se-main';

    for (const node of answerNodes) {
      node.classList.add('se-extra');
      main.appendChild(node);
    }

    if (results.length > 0) {
      // 记下解析结果，供设置改动后重建列表（见 rerenderResults）
      lastSearchResults = results;
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

    // ---- 4. 提交：构建已完成，此刻才动原站页面 -----------------------------
    //
    // 这一段全是「破坏性」操作，集中放在最后：
    //   搬走原站 DOM → 关掉它的样式表 → 换上我们的根容器。
    //
    // 为什么强调顺序 —— 失败后果完全不同：
    //   构建期抛错   → 页面原样可用（用户只是没看到增强，仍能正常搜索）
    //   提交之后抛错 → 原站 DOM 已搬走、样式已禁用，页面变成残废：
    //                  无样式、点不动，比「没增强」糟糕得多。
    // 早前版本在构建之前就禁用原站样式表，后续构建一旦出错就会留下
    // 那种残废状态 —— 这是实际踩过的坑，不是假设。
    //
    // 搬移而不是删除，是为自动翻页脚本（东方永页机 / Pagetual）：
    // 它是自驱动的，靠分析当前页找「下一页链接」与「主内容容器」，
    // 早期版本直接 body.innerHTML = '' 会让它彻底失去锚点。
    // 改为搬进隐藏容器后：
    //   - 原 DOM 仍在文档中，Pagetual 的查询照常命中原有结构
    //   - 它把新一页的结果插进来后，由 pagetual-bridge 采出来渲染进我们的列表
    //   - 用户看到的仍是干净的重写页面（隐藏容器不可见、不可聚焦）
    // 用 appendChild 搬移而非克隆：保留节点上的事件监听，
    // 必应自己的脚本与 Pagetual 的对象引用都继续有效。
    const source = clipOriginalContent();

    document.body.className = 'se-stripped';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.className = 'se-root-html';

    /*
     * 原站 DOM 已搬走，但它的样式表还挂在 <head> 上、继续全局生效，
     * 会用它自己的通用选择器盖掉我们新写的元素（实测面板里的输入框
     * 被染成 #444 文字配 #ddd 边框）。故整体禁用 ——
     * CSS 的生效范围与 DOM 位置无关，搬进 #se-source 也不管用。
     *
     * 清理是按 id 排除自家样式表的，而 GM_addStyle 注入的那份没有 id，
     * 会被一并关掉，所以紧接着把我们的样式补回来。
     */
    disableForeignStylesheets();
    reassertOwnStyle();

    document.body.appendChild(root);

    // 隐藏结果的「单击展开」用事件委托，无需给每个条目单独绑定
    bindHiddenToggle(root);

    // 补上依赖动态状态的一小段规则；主体样式由 Runner 统一注入
    const style = document.createElement('style');
    style.id = 'se-rewrite-style';
    style.textContent = 'html.se-root-html { height: auto; }';
    document.head.appendChild(style);

    const after = document.body.querySelectorAll('*').length;
    const hidden = source.querySelectorAll('*').length;
    // 用 warn 级别输出关键诊断：Firefox 默认会显示 console.warn，
    // 而 console.info 需开启调试等级才可见，跨浏览器排查时容易看不到。
    log.warn(
      `[重写完成] DOM ${before} → ${after}（其中隐藏数据源 ${hidden} 个节点），` +
        `结果 ${results.length} 条，分页 ${pages.length} 项（${lastPaginationDebug}）`,
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

  /*
   * 小标题独占一行，右侧留出菜单挂载点。
   * 页头只负责「排版与留位」，菜单由 tool-menu 功能负责填充 ——
   * 这样页头不必知道菜单里有什么，菜单换实现也不影响页头。
   */
  const brandRow = document.createElement('div');
  brandRow.className = 'se-brand-row';

  const menuSlot = document.createElement('div');
  menuSlot.className = MENU_SLOT_CLASS;

  brandRow.append(brand, menuSlot);
  head.appendChild(brandRow);

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
  // 条数记在 dataset 上：自动翻页加载新页后条数会变，
  // 失焦还原时需按「当前」条数显示，不能依赖构建时捕获的闭包值
  stat.dataset.count = String(count);
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
    // 按 dataset 上的当前条数还原，自动翻页追加后数字才是对的
    stat.textContent = `找到 ${stat.dataset.count ?? count} 条结果`;
  });

  head.appendChild(form);
  return head;
}

/**
 * 更新页头的结果计数。
 *
 * 自动翻页脚本加载新页后，条目会变多，计数需要跟着走。
 * 正在编辑查询词时不覆盖提示文案。
 */
export function updateResultCount(total: number): void {
  const stat = document.querySelector<HTMLElement>('.se-stat');
  if (!stat) return;
  stat.dataset.count = String(total);
  if (document.activeElement?.classList.contains('se-query')) return;
  stat.textContent = `找到 ${total} 条结果`;
}

/** 构建结果列表 */
function buildResultList(results: SearchResult[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'se-list';
  list.id = LIST_ID;
  list.append(...buildResultItems(results, 0));
  return list;
}

/**
 * 构建结果条目。
 *
 * 单独拆出来是为了支持「追加」：与自动翻页脚本（如东方永页机）
 * 协同工作时，新加载的一页要接着已有条目往后追加，
 * 而不是重建整个列表 —— 重建会丢掉用户当前的滚动位置与悬停状态。
 *
 * @param startIndex 已渲染的条目数，用于续上序号
 */
export function buildResultItems(
  results: SearchResult[],
  startIndex: number,
  rules: FilterRule[] = getRules(),
): HTMLElement[] {
  return results.map((result, offset) => {
    const item = document.createElement('li');
    item.className = 'se-item';

    // 目标地址：优先解析出的真实地址，回退引擎跳转链接
    const href = result.url ?? result.link?.href;

    // 左栏：序号。瑞士风格用等宽数字建立纵向韵律，替代装饰性图形
    const num = document.createElement('span');
    num.className = 'se-num';
    num.textContent = String(startIndex + offset + 1).padStart(2, '0');

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

    // badge 命中时，在标题文字**之前**插入「已排除」标签。
    // hide 不走这里 —— 它整条换成占位，见下方 hideItemBody。
    const hitRule = matchRule(href, rules);
    if (hitRule?.action === 'badge') {
      heading.appendChild(buildFilterTag());
    }

    const anchor = document.createElement('a');
    anchor.className = 'se-link';
    anchor.textContent = result.title || result.displayUrl || '(无标题)';
    /*
     * 标题锚点必须带上 href。
     * 它带 pointer-events: auto，会把点击从下方的 .se-hit 手里接过来；
     * 若不赋 href，点击就落到一个空链接上、什么也不会发生 ——
     * 表现为「点标题没反应」。早期版本正是漏了这一步。
     */
    applyLinkAttrs(anchor, href);
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
    // （利于中键新标签、复制链接、右键菜单）。
    const hit = document.createElement('a');
    hit.className = 'se-hit';
    hit.setAttribute('aria-hidden', 'true');
    hit.tabIndex = -1;
    applyLinkAttrs(hit, href);

    item.append(num, hit, body);

    /*
     * 把「恢复隐藏项」所需的地址留在节点上。
     *
     * 只存 href：标题与摘要的 DOM 节点是**整块搬走并留存引用**的
     * （见 hideItemBody），恢复时原样放回，
     * 不需要（也不该）再从字符串重拼一遍。
     */
    if (href) item.dataset.seHref = href;

    /*
     * 隐藏态：整条降级为「占位」。
     *
     * 占位条上只留一个「该结果已隐藏」，
     * 位置正是正常条目的**链接所在处**（body 栏内、来源行那一行）——
     * 标题与摘要一并撤掉，不再以灰字形式残留。
     * 用户点任意位置即可恢复，恢复后才把标题/摘要重新放回去。
     *
     * href 要摘掉：占位条不是个链接，不该有「点开就跳走」的语义，
     * 也不该被浏览器当成可聚焦的链接（那会在点击时冒出焦点框）。
     */
    if (hitRule?.action === 'hide') {
      item.classList.add('se-item-hidden');
      hit.removeAttribute('href');
      hideItemBody(body);
    }

    return item;
  });
}

/**
 * 把 body 栏的内容换成单个「该结果已隐藏」占位。
 *
 * 用「移出文档并留存引用」而非直接删除：
 * 标题锚点与摘要在恢复时原样放回即可，
 * 不必重新拼字符串 —— 标题里可能含 HTML 实体或特殊字符，
 * 往返一次既慢又有走样风险。
 *
 * 留存方式：把原标题/摘要的节点整体搬进一个游离容器（不在文档里），
 * 引用挂在 body 上。恢复时原样搬回即可 ——
 * 不必重新拼字符串，标题里含 HTML 实体或特殊字符也不会走样。
 * 游离容器随 body 一起被回收，不留泄漏。
 */
function hideItemBody(body: HTMLElement): void {
  // 已隐藏过就不重复处理（重渲染与永页机追加都可能再走到这里）
  if (body.dataset.seHidden) return;
  body.dataset.seHidden = '1';

  // 把原标题/摘要收进一个游离容器，恢复时整体放回
  const stash = document.createElement('div');
  while (body.firstChild) stash.appendChild(body.firstChild);
  (body as unknown as Record<string, unknown>).__seStash = stash;

  const placeholder = document.createElement('p');
  placeholder.className = 'se-tag se-tag-hidden';
  placeholder.textContent = '该结果已隐藏';
  body.appendChild(placeholder);
}

/**
 * 反向操作：撤掉占位，把原先的标题与摘要放回。
 */
function restoreItemBody(body: HTMLElement): void {
  if (!body.dataset.seHidden) return;
  delete body.dataset.seHidden;

  const stash = (body as unknown as Record<string, unknown>).__seStash as
    | HTMLElement
    | undefined;
  if (stash) {
    body.textContent = '';
    while (stash.firstChild) body.appendChild(stash.firstChild);
    delete (body as unknown as Record<string, unknown>).__seStash;
    return;
  }

  // 理论上到不了这里；真到了就只清掉占位，避免卡在半隐藏态
  body.textContent = '';
}

/**
 * 「已排除」标签：置于标题文字之前的小字标记。
 *
 * 只由 badge 使用。hide 的「该结果已隐藏」不走这里 ——
 * 它是整条占位的唯一内容，位置在链接处而非标题前（见 hideItemBody）。
 */
function buildFilterTag(): HTMLElement {
  const tag = document.createElement('span');
  tag.className = 'se-tag se-tag-excluded';
  tag.textContent = '已排除';
  tag.setAttribute('aria-hidden', 'true');
  return tag;
}

/*
 * ============ 隐藏结果的单击展开 ============
 *
 * 用事件委托绑在根容器上，而不是逐条绑定：
 * 条目会被增量追加（永页机协同）与整表重建（改动过滤规则），
 * 逐条绑定必然漏掉后来者。
 */
const TOGGLE_BOUND = '__seFilterToggleBound__';

function bindHiddenToggle(root: HTMLElement): void {
  const flag = root as unknown as Record<string, unknown>;
  if (flag[TOGGLE_BOUND]) return;
  flag[TOGGLE_BOUND] = true;

  /*
   * 在 mousedown 就拦下默认行为。
   *
   * 浏览器「按下鼠标即聚焦」——聚焦后若元素可聚焦，
   * 会画出焦点环。占位条本身不可聚焦（无 href、无 tabindex），
   * 但点击仍可能让**祖先**拿到 :focus-within，
   * 于是整条套上一个红框。这里阻止按下时的默认聚焦动作，
   * 从源头断掉焦点环的产生。
   * 只在真正命中占位条时拦，避免影响正常条目的点击与文本选择。
   */
  root.addEventListener(
    'mousedown',
    (event) => {
      const target = event.target as Element | null;
      if (target?.closest('.se-item-hidden')) event.preventDefault();
    },
    true,
  );

  root.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      // 点在标题链接或整条链接上时，交给它们各自处理（正常跳转）
      if (target?.closest('a.se-link, a.se-hit[href]')) return;
      const item = target?.closest<HTMLElement>('.se-item-hidden');
      if (!item) return;
      // 占位条上没有真实链接，不会误跳转，只需阻止默认行为
      event.preventDefault();
      revealItem(item);
    },
    // 捕获阶段：占位条的覆盖锚点虽被移除了 href，仍可能吞掉事件
    true,
  );
}

/**
 * 让一条隐藏的结果恢复为正常条目。
 *
 * 用「重放」而非「重算」：
 * 该条目当初就是按正常规则构建的，只是随后被降级了；
 * 因此从节点上留存的引用与 dataset 里取回原始内容即可，
 * 无需再解析一遍搜索页。
 *
 * 恢复后与用户从未隐藏过的条目无任何区别 ——
 * 占位文字撤除，标题、来源、摘要原样归位。
 */
function revealItem(item: HTMLElement): void {
  const body = item.querySelector<HTMLElement>('.se-body');
  const href = item.dataset.seHref;
  if (!body) return;

  // 撤掉占位标记，把标题与摘要放回
  item.classList.remove('se-item-hidden');
  restoreItemBody(body);

  /*
   * 恢复覆盖锚点的地址与可点性。
   *
   * aria-hidden 与 tabIndex 保持不动：
   * 正常条目上也一直带着 aria-hidden="true"（它是无文字内容的拉伸链接，
   * 文字由 .se-link 承担，重复播报没有意义），tabIndex 同理是构建时设好的。
   * 早期版本在这里 removeAttribute —— 结果解除隐藏的条目
   * 比普通条目少一个属性，正是「无任何区别」最忌讳的偏差。
   */
  const hit = item.querySelector<HTMLAnchorElement>('.se-hit');
  if (hit && href) applyLinkAttrs(hit, href);

  log.info('已解除隐藏：', item.dataset.seHref);
}

/** 为锚点写入地址与打开方式（新标签页，且不泄漏 referrer） */
function applyLinkAttrs(anchor: HTMLAnchorElement, href: string | undefined): void {
  if (!href) return;
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
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

/**
 * 甄别并清理一个直答区节点。
 *
 * 做三件事（见调用处说明），返回 true 表示该节点值得保留。
 */
function pruneAnswerNode(node: HTMLElement): boolean {
  // 节点本身就是相关搜索 → 整体丢弃
  if (isRelatedSearchBlock(node)) return false;

  // 剔除内部的相关搜索子模块
  for (const el of Array.from(node.querySelectorAll('*'))) {
    if (isRelatedSearchBlock(el)) el.remove();
  }

  /*
   * 剔除内联样式表与外链。
   * 这些是 Bing 给该模块配的样式，保留下来会**全局生效**，
   * 干扰我们自己的排版（原站 CSS 的作用域依赖已清空的外层结构）。
   */
  for (const el of Array.from(node.querySelectorAll('style, link'))) el.remove();

  // 剔除备案号 / 隐私政策等合规链接
  stripComplianceLinks(node);

  /*
   * 清理后若已无实质内容，视作空壳丢弃。
   * 阈值取 10 个字符：保留真正有信息量的模块，滤掉只剩残留标点的。
   */
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length >= 10;
}

/*
 * ============ 关掉原站样式表 ============
 *
 * 重写只清空了原站的**内容**，但 Bing 的样式表挂在 <head> 上，一直留着。
 * CSS 的生效范围与 DOM 位置无关 —— 就算把 <link> 搬进 #se-source 也照样生效，
 * 所以只能禁用或删除。
 *
 * 不管它会出什么问题（实测）：Bing 的通用选择器会盖掉我们面板里的控件，
 * 输入框文字变 #444、边框 #ddd，暗色模式下尤其刺眼。
 * 页面主体之所以看着还正常，是因为我们的规则恰好更具体；
 * 一旦某条 Bing 规则更具体（或只差在加载顺序上），就会被它压过去。
 *
 * 用 disabled 而不是 remove：节点仍留在文档里，
 * 原站脚本或自动翻页脚本若引用这些节点不会拿到 null。
 */

/** 这些 id 是本脚本自己的样式表，必须留着 */
const KEEP_STYLE_IDS = new Set(['search-enhance-styles', 'se-rewrite-style']);

/** 判断一个节点是否为需要禁用的原站样式表 */
function isForeignStylesheet(node: Node): node is HTMLLinkElement | HTMLStyleElement {
  if (!(node instanceof HTMLElement)) return false;
  if (KEEP_STYLE_IDS.has(node.id)) return false;
  if (node.tagName === 'STYLE') return true;
  return node.tagName === 'LINK' && node.getAttribute('rel') === 'stylesheet';
}

/** 关掉文档中所有原站样式表（含后来者） */
function disableForeignStylesheets(): void {
  const sweep = (root: ParentNode): number => {
    let count = 0;
    for (const el of Array.from(
      root.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'),
    )) {
      if (!isForeignStylesheet(el)) continue;
      el.disabled = true;
      count++;
    }
    return count;
  };

  const disabled = sweep(document);
  log.warn(`[样式隔离] 已禁用 ${disabled} 个原站样式表`);

  /*
   * 一次性扫不够：Bing 的脚本在重写之后仍会继续执行
   * （实测它会把 b_norr / b_sbText 之类的类名重新加回 body），
   * 也就可能再插样式表。挂个观察器兜住后来者。
   *
   * 只在新增节点里找，不做全量重扫 —— 这个观察器挂在 document 上、
   * 结果列表每次追加都会触发，全量重扫会白白拖慢页面。
   *
   * 属性也要看：实测有少数 <link> 是**先插入、后设置 rel**
   * （创建时不带 rel，插入后才赋成 stylesheet），
   * 只看 childList 会漏掉它们 —— 那 4 个漏网的样式表就是这么来的。
   */
  if (document.documentElement.hasAttribute('data-se-style-guard')) return;
  document.documentElement.setAttribute('data-se-style-guard', '1');

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      // 属性变化：目标是 <link> 时重新判定一次
      if (record.type === 'attributes') {
        const el = record.target;
        if (el instanceof HTMLElement && !(el as HTMLLinkElement).disabled && isForeignStylesheet(el)) {
          (el as HTMLLinkElement).disabled = true;
        }
        continue;
      }

      for (const node of Array.from(record.addedNodes)) {
        if (isForeignStylesheet(node)) {
          (node as HTMLLinkElement | HTMLStyleElement).disabled = true;
          continue;
        }
        // 新增的是容器时，检查其内部是否夹带了样式表
        if (node instanceof HTMLElement) {
          for (const el of Array.from(
            node.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'),
          )) {
            if (isForeignStylesheet(el)) el.disabled = true;
          }
        }
      }
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['rel', 'href'],
  });
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

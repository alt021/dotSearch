import type { Feature } from '../types/feature.js';
import type { EngineAdapter, SearchResult } from '../types/engine.js';
import { log } from '../core/env.js';
import { getRules, matchRule, type FilterRule } from './filter-store.js';
import { isPrivacyEnabled } from './settings-store.js';
import { cleanAddressBar, sanitizeSearchUrl } from './privacy.js';

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

/**
 * 直答区候选。
 *
 * 实测 `#b_context` 是右侧栏「更多结果」的容器，
 * 其下的 `<li class="b_ans">` 既可能承载真正的直答模块，
 * **也可能只是「相关搜索」**(`<div class="b_rs rsExplr">`)，后者不应保留。
 * 因此这里只做候选收集，由 pruneAnswerNode() 逐个甄别。
 */
const ANSWER_SELECTOR = '#b_context .b_ans';

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
 * 重写时把必应原有 DOM 整体搬进这里而非删除。
 * 它不再是给第三方翻页脚本留的锚点，而是留给本脚本自己：
 * 必应（尤其 www 版）会在重写之后才补齐分页链接，
 * 继续观察这份仍然活着的原站 DOM，才能知道「后面还有没有结果」。
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
 * 每页条数的兜底值。
 *
 * 只在「偏移量差推不出、当前页条数也拿不到」时才会用到 ——
 * 必应桌面版是 10。真正的来源是 `detectPageSize()` 的偏移差与
 * `sizeHint`（当前页条数）。
 */
const DEFAULT_PAGE_SIZE = 10;

/** 页码上限：只为解析异常数据设一个护栏，不代表实际能翻到这么多页 */
const MAX_PAGE_COUNT = 50;

/**
 * 当前页的分页参数。由 `resolvePagination()` 在重写时写入。
 *
 * 页码栏已经移除，这些值仍有用途：
 *   - 序号要从「当前页的全局起点」接着数；
 *   - 「加载更多」要知道每页条数、当前页号，才能拼出下一页地址。
 */
let pageSize = DEFAULT_PAGE_SIZE;
let pageNumber = 1;

/** 拼下一页地址所用的基址、搜索词参数与原站给出的总页数 */
let paginationBase: URL | null = null;
let paginationQueryParam = 'q';
let paginationMaxPage = 1;

/**
 * 原站稍后补齐分页链接时派发。
 *
 * 必应（尤其 www 版）先出结果、后补分页，重写时可能只看到当前页
 * 那一个 first= 链接。加载更多按钮据此重新判断「是否还有下一页」。
 */
export const PAGINATION_UPDATED_EVENT = 'dotsearch:pagination-updated';

/** 重写后继续盯住数据源里的分页（见 watchSourcePagination） */
let paginationObserver: MutationObserver | null = null;
let paginationRefreshTimer = 0;

/**
 * 当前页第一条第「全局序号」（0-based）。
 *
 * 必应第二页（`first=11`，每页 10 条）的第一条实际是第 11 条结果，
 * 序号就该从 11 开始 —— 而不是重新从 01 数。
 * 加载更多追加的页也在「当前页起点 + 已渲染条数」上续号。
 */
function pageStartIndex(): number {
  return (pageNumber - 1) * pageSize;
}

/** 页头统计文案：只报已加载条数，页面不再有「第几页」的概念 */
function statText(total: number): string {
  return `找到 ${total} 条结果`;
}

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
  list.append(...buildResultItems(lastSearchResults, pageStartIndex(), rules));
  log.info(`已按 ${rules.length} 条过滤规则重建列表（含已加载的 ${lastSearchResults.length} 条）`);
  return true;
}

/**
 * 把新加载的一页追加到结果列表，并记进重建缓存。
 *
 * 缓存必须一起更新：过滤规则改动会按 `lastSearchResults` 整表重建，
 * 只把节点塞进 DOM 的话，用户改一条规则，加载更多得来的一切就消失了。
 *
 * @returns 追加后的总条数（含被过滤规则隐藏的条目）
 */
export function appendResults(results: SearchResult[]): number {
  const list = document.getElementById(LIST_ID);
  if (!list || results.length === 0) return lastSearchResults.length;

  const seen = new Set(lastSearchResults.map(resultKey));
  const fresh = results.filter((result) => {
    const key = resultKey(result);
    if (key !== '' && seen.has(key)) return false;
    if (key !== '') seen.add(key);
    return true;
  });
  if (fresh.length === 0) return lastSearchResults.length;

  const start = pageStartIndex() + lastSearchResults.length;
  list.append(...buildResultItems(fresh, start));
  lastSearchResults = lastSearchResults.concat(fresh);
  updateResultCount(lastSearchResults.length);
  return lastSearchResults.length;
}

/** 结果去重键：优先真实地址，回退引擎跳转地址 */
function resultKey(result: SearchResult): string {
  return result.url ?? result.link?.href ?? '';
}

/** 已加载（含隐藏）的结果条数 */
export function getLoadedResultCount(): number {
  return lastSearchResults.length;
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
 * 搬移会保留节点上已绑定的事件监听，必应自己的脚本继续引用同一批节点；
 * innerHTML 赋值会重建节点，等于把别人的监听全清掉。
 *
 * 保留（而不是删除）原站 DOM 还有一个明确用途：
 * 必应会在页面加载后继续往里补分页链接，而这些链接是
 * 「后面还有没有结果」的唯一可靠线索（见 watchSourcePagination）。
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

  dispose() {
    stopWatchingPagination();
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
     * 分页通常晚于结果容器渲染（www 版尤其明显）。
     * 这里等一小会儿，只为让每页条数 / 总页数尽量取准 ——
     * 它们决定「加载更多」拼出的下一页地址与初始按钮是否显示。
     * 原站本就没有分页时等满超时，属正常情况。
     */
    await waitForPagination(1_000);

    // ---- 1. 解析结果为结构化数据（必须在清空 DOM 之前完成）---------------
    const results = engine.extractResults(container);
    resolvePagination(engine.searchForm.param, results.length);

    /*
     * 直答区：逐个甄别后再保留。
     * 该节点是唯一会保留到新页面的原站内容，需做三项清理：
     *   1. 剔除「相关搜索」模块（用户明确不需要）
     *   2. 剔除内联 <style>/<link>，否则原站 CSS 会泄漏进改写后的页面
     *   3. 剔除备案号、隐私政策等合规链接
     * 清理后若已无实质内容，则整体丢弃，不留空壳。
     */
    const answerNodes = Array.from(
      document.querySelectorAll<HTMLElement>(ANSWER_SELECTOR),
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
    // 原站 DOM 搬进隐藏容器而不是删除：必应会在加载后继续往里补
    // 分页链接，而那是判断「后面还有没有结果」的可靠线索。
    // 用 appendChild 搬移而非克隆：保留节点上的事件监听，
    // 必应自己的脚本继续引用同一批节点。
    /*
     * 会话采集必须在清空 DOM 之前：判据在必应顶栏
     * （`#id_a` / `#id_l` / `#id_p`）里，重写后就不存在了。
     * 引擎没实现这个钩子（例如没有账户概念）时直接跳过。
     */
    engine.captureSession?.();

    const source = clipOriginalContent();

    document.body.className = 'se-stripped';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.className = 'se-root-html';

    /*
     * 这里**不再**禁用原站的样式表。
     *
     * 那样做会连带关掉其它脚本的样式，
     * 而且会让只靠原站 CSS 隐藏的浮层全部显形（overlay-dimmer 就是全屏遮罩）。
     * 我们的控件配色改由 base.css 里的 `!important` 兜底解决，
     * 详细取舍见文件末尾「关于原站样式表」那段说明。
     */
    document.body.appendChild(root);

    // 原站分页可能还在路上，重写后继续盯着（见 watchSourcePagination）
    watchSourcePagination(source);

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
        `结果 ${results.length} 条（${lastPaginationDebug}）`,
    );

    /*
     * 隐私模式：把地址栏换成净化后的地址。
     *
     * ⚠️ 必须放在**重写完成之后**（这里），不能提前到构建阶段：
     * replaceState 会触发 onUrlChange 的通知，Runner 收到后可能再跑一轮。
     * 此刻根容器已就位，needsRebuild() 才会判为「状态完整」而跳过；
     * 若在构建期间就改地址，重新进入的 runAll 会看到「没有根容器」，
     * 于是两份重写并发执行，页面出现重复的 se-root。
     *
     * 净化后「加载更多」拼出的下一页地址也不会再带着 cvid / form
     * 之类的参数，因为分页基址取自 location.href（见 buildPageHref）。
     */
    if (isPrivacyEnabled() && cleanAddressBar(engine.searchForm.param)) {
      log.info('净化链接：已去掉地址栏中的追踪参数');
    }
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
  // 条数记在 dataset 上：加载更多追加新页后条数会变，
  // 失焦还原时需按「当前」条数显示，不能依赖构建时捕获的闭包值
  stat.dataset.count = String(count);
  // 默认显示结果数；进入编辑态后改为提示回车提交
  stat.textContent = statText(count);

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
    // 按 dataset 上的当前条数还原，加载更多追加的数字才是对的
    stat.textContent = statText(Number(stat.dataset.count ?? count));
  });

  head.appendChild(form);
  return head;
}

/**
 * 更新页头的结果计数。
 *
 * 加载更多追加后条目会变多，计数需要跟着走。
 * 正在编辑查询词时不覆盖提示文案。
 */
export function updateResultCount(total: number): void {
  const stat = document.querySelector<HTMLElement>('.se-stat');
  if (!stat) return;
  stat.dataset.count = String(total);
  if (!document.activeElement?.classList.contains('se-query')) {
    stat.textContent = statText(total);
  }
}

/** 构建结果列表 */
function buildResultList(results: SearchResult[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'se-list';
  list.id = LIST_ID;
  /*
   * 序号从**当前页的全局起点**开始，而不是 0。
   * 第 2 页（first=11、每页 10 条）的第一条是第 11 条结果，
   * 继续往后追加时也沿用这条全局规则；页头只报已加载条数。
   */
  list.append(...buildResultItems(results, pageStartIndex()));
  return list;
}

/**
 * 构建结果条目。
 *
 * 单独拆出来是为了支持「追加」：加载更多拿到新一页后，
 * 要接着已有条目往后追加，而不是重建整个列表 ——
 * 重建会丢掉用户当前的滚动位置与悬停状态。
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
  // 已隐藏过就不重复处理（重渲染与追加都可能再走到这里）
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
 * 条目会被增量追加（加载更多）与整表重建（改动过滤规则），
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
 * ## 现方案：只读取「有几页」，下一页地址自己拼
 *
 * 唯一跨场景稳定的信息是 first= 这个结果偏移量
 * （第 N 页 = first=(N-1)*10+1）。它同时出现在：
 *   - 翻页链接的 href 里
 *   - 页面内联脚本的配置数据里
 *
 * 因此从「DOM 链接」与「整份 HTML」两处收集偏移量，推出每页条数与最大页数，
 * 再用当前 URL 自己拼出下一页的地址。加载更多不依赖原站链接是否可点。
 */

/** 从 URL 串中提取 first= 偏移量 */
const FIRST_PARAM_RE = /[?&]first=(\d+)/g;

/**
 * 分页「线索」= **真正可点的页码链接**，而不是分页容器。
 *
 * ⚠️ 这里踩过坑：原先把 `.b_pag` / `.sb_pagF` 这些**容器**当线索，
 * 而必应是「先渲染空容器、稍后才填页码」的两步 ——
 * 于是等待函数一看到容器就立刻返回，紧接着提取到 0 个页码，
 * 页面表现为「原站分了 3 页却只显示 1 页」，且时快时慢（竞态）。
 * 判据必须落在容器**内部的链接**上：
 *   - `a[href*="first="]`  换页链接（Bing 的页码都带 first= 偏移）
 *   - `.b_pag a` / `.sb_pagF a`  容器内的页码链接
 * 注意 `.b_pag` 内还有一个 `<link rel="stylesheet">`，
 * 但那是 `<link>` 不是 `<a>`，不会被误判。
 */
export const PAGINATION_HINT_SELECTOR =
  'a[href*="first="], .b_pag a, .sb_pagF a, .sb_pag a';

/* 每页条数（DEFAULT_PAGE_SIZE）与页码上限（MAX_PAGE_COUNT）在文件顶部定义：
   序号偏移与页头统计也要用，放在这里会导致模块求值时访问未初始化的 const。 */

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


/** 收集归集范围内出现的所有 first= 偏移量 */
function collectPageOffsets(root: ParentNode = document): number[] {
  const offsets = new Set<number>();

  // 来源 1：带 first= 的翻页链接（最可靠）
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
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
    const html = root instanceof Element ? root.innerHTML : document.documentElement.innerHTML;
    FIRST_PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FIRST_PARAM_RE.exec(html))) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) offsets.add(n);
    }
  }

  return [...offsets].filter((n) => n >= 1).sort((a, b) => a - b);
}

/**
 * 由偏移量差值推断每页条数。
 *
 * @param sizeHint 当前页**实际渲染出的结果条数**。只在无法从偏移量差值
 *   推断时启用。
 *
 * ⚠️ 不能只靠偏移量：分页控件有时只暴露一个 `first=`（例如只有「下一页」），
 * 偏移量集合里没有相邻差，于是这里会回退到默认的 10 —— 若真实每页条数
 * 不是 10，页号就会整页偏移一位，序号跟着错，用户看到的就是
 * 「第二页又从 01 开始」。当前页满页时条数正好等于每页条数，用它兜底最可靠。
 *
 * ⚠️ 但条数必须**先归位到标准档位**再用：www 版会先渲染 1~9 条、
 * 稍后才补满，直接在那一刻取用会把「每页条数」测成 9 或 1，
 * 生成的第 3 页地址变成 `first=19`（仍落在第 2 页），后续页码整体错位。
 */
function detectPageSize(offsets: number[], sizeHint = 0): number {
  // 相邻偏移量之差即每页条数；取最小正值以兼容不连续的偏移集合
  const diffs: number[] = [];
  for (let i = 1; i < offsets.length; i++) {
    const prev = offsets[i - 1];
    const cur = offsets[i];
    if (prev === undefined || cur === undefined) continue;
    const d = cur - prev;
    if (d > 0) diffs.push(d);
  }
  if (diffs.length > 0) return Math.min(...diffs);
  if (sizeHint > 0) return snapPageSize(sizeHint);
  return DEFAULT_PAGE_SIZE;
}

/** 必应「每页结果数」的可选档位（设置页里就是这几档） */
const PAGE_SIZE_CHOICES = [10, 20, 30, 50];

/** 把实际渲染条数向上归位到标准档位（9 → 10、13 → 20） */
function snapPageSize(sizeHint: number): number {
  return PAGE_SIZE_CHOICES.find((n) => n >= sizeHint) ?? sizeHint;
}

/** 第 1 页为 1；URL 不带 first= 即第 1 页 */
function currentPageNumber(size: number): number {
  const raw = new URL(location.href).searchParams.get('first');
  const offset = raw === null ? 1 : Number(raw);
  if (!Number.isFinite(offset) || offset <= 1) return 1;
  /*
   * 与生成链接时同一套换算（见 offsetToPage 的说明）：
   * 必应的 first= 有 1-based（11/21）与 0-based（10/20）两种约定，
   * floor(offset / size) + 1 对两者都成立。
   * 早前这里写的是 floor((offset-1)/size)+1，0-based 会少算一页。
   */
  return offsetToPage(offset, size);
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
function collectRenderedPageNumbers(root: ParentNode = document): number[] {
  const nums = new Set<number>();

  for (const a of root.querySelectorAll<HTMLAnchorElement>('a')) {
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

/**
 * 基于当前 URL 构造第 page 页的地址。
 *
 * 隐私模式下先净化基址：分页链接会出现在页面上、可被复制与分享，
 * 若把它们照着原地址（含 cvid / form 等）拼出来，
 * 等于把追踪参数一路传播到后面每一页。
 */
function buildPageHref(base: URL, page: number, pageSize: number, queryParam: string): string {
  const source = isPrivacyEnabled() ? sanitizeSearchUrl(base, queryParam) : new URL(base.href);
  const url = new URL(source.href);
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
function collectNumericPageHints(root: ParentNode = document): number[] {
  const nums = new Set<number>();
  const scopes = root.querySelectorAll(
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

/**
 * 从给定范围内读取所有分页线索。
 *
 * 总页数取各来源的最大值（偏保守，漏页比多页干扰小）：
 *   1. 原站渲染出的页码数字 —— 最权威，直接写着「2」「3」
 *   2. first= 偏移量反推 —— 覆盖页码文字非数字的情形
 *   3. 分页容器内的纯数字 —— 覆盖链接无 href 的 JS 驱动布局
 *
 * `max` 只来自线索，不含当前页：重写时若分页还没渲染完，
 * 这个值会偏小，由 watchSourcePagination 稍后补齐。
 */
function readPaginationHints(root: ParentNode = document): {
  rendered: number[];
  offsets: number[];
  max: number;
} {
  const offsets = collectPageOffsets(root);
  const rendered = collectRenderedPageNumbers(root);
  const fromOffsets = offsets.length > 0 ? offsetToPage(Math.max(...offsets), pageSize) : 0;
  const numericHints = rendered.length > 0 || fromOffsets > 0 ? [] : collectNumericPageHints(root);

  return {
    rendered,
    offsets,
    max: Math.max(
      rendered.length > 0 ? Math.max(...rendered) : 0,
      fromOffsets,
      numericHints.length > 0 ? Math.max(...numericHints) : 0,
    ),
  };
}

/**
 * 解析分页状态。
 *
 * 只读取「每页几条、当前第几页、原站说还有几页」——
 * 页码栏已移除，页面翻页由「加载更多」接管，这里不再生成任何链接。
 *
 * @param queryParam 引擎的搜索词参数名；隐私模式下净化分页基址时要用
 * @param sizeHint 当前页实际结果条数，用于在偏移量不足时推断每页条数
 */
function resolvePagination(queryParam = 'q', sizeHint = 0): void {
  const offsets = collectPageOffsets();
  pageSize = detectPageSize(offsets, sizeHint);
  const base = new URL(location.href);
  const current = currentPageNumber(pageSize);
  pageNumber = current;
  paginationBase = base;
  paginationQueryParam = queryParam;

  const hints = readPaginationHints();
  paginationMaxPage = Math.min(Math.max(current, hints.max), MAX_PAGE_COUNT);

  lastPaginationDebug =
    hints.max === 0
      ? `每页${pageSize}条 当前第${current}页 无后续页线索`
      : `页码[${hints.rendered.join(',') || '-'}] ` +
        `偏移[${hints.offsets.join(',') || '-'}] 每页${pageSize}条 ` +
        `当前第${current}页 总${paginationMaxPage}页`;
}

/** 「加载更多」拼下一页地址所需的状态 */
export interface PaginationState {
  /** 每页条数（原站设置或偏移量推断） */
  pageSize: number;
  /** 当前 URL 所在页 */
  pageNumber: number;
  /** 原站给出的最大页（可能因晚渲染而偏小，由 watchSourcePagination 补齐） */
  maxPage: number;
}

export function getPaginationState(): PaginationState {
  return { pageSize, pageNumber, maxPage: paginationMaxPage };
}

/** 按页码构造搜索页地址（隐私模式下先净化基址） */
export function buildPageUrl(page: number): string {
  const base = paginationBase ?? new URL(location.href);
  return buildPageHref(base, page, pageSize, paginationQueryParam);
}

/*
 * 重写完成后，原站分页往往还没渲染完。
 *
 * 必应（尤其 www 版）是「先出结果、后补分页」：重写时可能只等到当前页
 * 自己的那一个 first= 链接，总页数便被算成当前页。
 * 重写不删除原站 DOM，它只是被搬进数据源并继续被必应更新；
 * 盯着数据源即可在页码链接补齐时把总页数补上，并通知加载更多按钮。
 */
function watchSourcePagination(source: HTMLElement): void {
  stopWatchingPagination();
  paginationObserver = new MutationObserver(schedulePaginationRefresh);
  /*
   * 不只监听新增节点：必应也可能先摆好空链接、稍后才补 `href`，
   * 或把页码文字填进去 —— 这些是属性 / 文本变化，childList 看不到。
   */
  paginationObserver.observe(source, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
    characterData: true,
  });

  /*
   * 观察器只覆盖「此刻之后」的变化，而分页也可能恰好在提取之后、
   * 观察器挂上之前那段构建时间里补齐 —— 主动查一次兜住这个窗口。
   */
  schedulePaginationRefresh();
}

function schedulePaginationRefresh(): void {
  if (paginationRefreshTimer) return;
  paginationRefreshTimer = window.setTimeout(() => {
    paginationRefreshTimer = 0;
    refreshPagination();
  }, 250);
}

function stopWatchingPagination(): void {
  paginationObserver?.disconnect();
  paginationObserver = null;
  if (paginationRefreshTimer) {
    window.clearTimeout(paginationRefreshTimer);
    paginationRefreshTimer = 0;
  }
}

/** 原站补上新的页码线索后，扩充总页数（只增不减），并通知加载更多按钮 */
function refreshPagination(): void {
  const source = document.getElementById(SOURCE_ID);
  if (!source || !document.getElementById(ROOT_ID)) return;

  const max = Math.min(readPaginationHints(source).max, MAX_PAGE_COUNT);
  if (max <= paginationMaxPage) return;

  const previous = paginationMaxPage;
  paginationMaxPage = max;
  log.info(`[分页补齐] 原站分页稍后渲染：总页数 ${previous} → ${max}`);
  document.dispatchEvent(new CustomEvent(PAGINATION_UPDATED_EVENT));
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
 * ============ 关于原站样式表：**刻意不动它们** ============
 *
 * 曾经这里是「把必应的样式表全部 disabled」—— 理由是它的通用选择器会盖掉
 * 我们面板里的控件（实测输入框文字被染成 #444、边框 #ddd）。
 *
 * 那个做法已经**回退**，因为它连带的破坏远大于收益：
 *
 *  1. **别的脚本的样式也一起被关掉。** 同一个页面上还可能有用户安装的
 *     其它脚本 / 扩展，它们的界面靠自己注入的 CSS 渲染，一并禁用后会散架。
 *  2. **原本靠原站 CSS 才隐藏的元素会全部显形。** 实测必应会往 body 插
 *     `div.overlay-dimmer`（position:fixed、z-index:9998、pointer-events:auto、
 *     铺满视口），它只靠必应样式表里的 `.b_hide { display:none }` 才不显示 ——
 *     CSS 一禁，它就变成全屏点击拦截层，整页点不动。
 *
 * 现在改为**与必应样式表共存**，用两个更精确的手段解决各自的问题：
 *   - 我们的控件配色改由 `!important` 兜底（见 base.css 的「控件配色兜底」段），
 *     只作用于自己的类名，不碰任何第三方样式；
 *   - 必应那几件确实不该出现在重写页上的 UI（选中文字的快捷搜索浮窗）
 *     用**按 id 精确命中**的规则隐藏，同样不波及第三方。
 */

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

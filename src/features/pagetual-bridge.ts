/**
 * 永页机（东方永页机 / Pagetual）协同
 *
 * ## 问题背景
 *
 * 永页机是**自驱动**的自动翻页脚本：它自行分析当前页面，
 * 找出「下一页链接」与「主内容容器」，抓取下一页后把内容插进当前页。
 * 而「重写结果页」会把必应原有 DOM 搬进隐藏容器、另建一套界面，
 * 于是永页机面对的是一个「结构不对」的页面 —— 插进来的内容也无人处理。
 *
 * ## 本模块做什么
 *
 * 只做一件事：**把插进来的原站内容，翻译成我们自己的条目**。
 *
 *   - 监听永页机公开的 postMessage 协议（insert / lastPage），
 *     这是它的正式协作接口，比轮询可靠
 *   - 同时用 MutationObserver 兜底，覆盖它不发言或版本不同的情形
 *   - 每次变化后重新解析数据源，把**新增的**追加到列表末尾
 *
 * 只追加、不重建：重建会丢掉用户的滚动位置与悬停状态。
 *
 * ## 桌面端与手机端是同一套逻辑（本模块的关键设计）
 *
 * 两端的差别只有一处：**新页插在哪个容器里**。
 *
 *   桌面端 → 插进 `#b_results`，而它已随原站 DOM 搬进 `#se-source`，
 *            于是天然就是数据源的一部分，什么都不用做。
 *   手机端 → 插到 `#se-source` 之外（body 上），原样留在版面上就会
 *            以原站样式盖住我们的界面，也采不到。
 *
 * 早期版本把「数据源」等同于 `#se-source` 这**一个元素**，
 * 于是手机端完全失效。现在把数据源定义为「页面里所有原站结果条目」：
 *
 *   - 观察范围：`document.body` 整棵子树（`#se-source` 只是其中的一部分）
 *   - 采集范围：整页找原站结果条目，按**条目的父元素**分组交给引擎解析。
 *     刻意不按固定容器选择器取 —— 手机端插入的容器未必叫 `#b_results`，
 *     而"有条目就有父元素"这一点永远成立
 *   - 归拢：每次同步先做一次**全量扫描** —— 页面上所有不属于我们的
 *     原站结果条目，连同它所在的结果容器，一律搬进 `#se-source`
 *     （不可见、可采集，等价于"它本来就插在数据源里"）。
 *     不按插入位置分流，也不依赖 mutation 的节点判断。
 *
 * 于是两端跑的是同一条代码路径，没有 `isMobile` 之类的分支：
 * 桌面端的新页本来就在数据源里，归拢那一步对它是个 no-op。
 *
 * ## 三个容易踩错的细节
 *
 * 1. **它会插入一个新的容器，而不是往同一个容器里塞**
 *    （把新页的 `#b_results` 接在旧容器之后）。
 *    因此采集时必须遍历**所有**匹配的结果容器，
 *    只查第一个会永远看不到新内容。
 *
 * 2. **靠条数差判断新增不可靠**
 *    容器被替换、重排都会让计数错位。改为按 URL 去重：
 *    只追加「地址尚未出现过」的条目。
 *
 * 3. **只对「新增的原站结果」反应，不对删除反应**
 *    过滤规则改动会触发 rerenderResults() 清空并重画 `.se-item`。
 *    若把这种重画也算作永页机变化，sync 会把已经渲染过的结果
 *    再采一遍，造成条目成倍增长。因此只看 `addedNodes`，
 *    且只接受原站结果容器 / 原站结果条目；本脚本自己的
 *    `.se-item` 增删一律忽略。
 *
 * ## 归拢的边界（重要）
 *
 * 搬动的是**条目所在的容器**，不是"往上一路收"。上限三层，且一旦发现
 * 目标节点包含 `#se-root` / `.se-list` / `.se-item` 就立即放弃，
 * 退化为只搬条目本身 —— 宁可留一个空壳，也绝不能把整个界面
 * 塞进 1px 容器。
 *
 * 早期版本曾尝试"给外部容器加一个类隐藏"，但它必须精确命中
 * 每一次插入的容器，判错一次就会留下整块原版内容；
 * 而搬进数据源这个动作是**幂等**的，错过的下一轮还会被扫到。
 */
import type { Feature } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import type { SearchResult } from '../types/engine.js';
import { log } from '../core/env.js';
import {
  RESULTS_RERENDERED_EVENT,
  SOURCE_ID,
  buildResultItems,
  getResultStartIndex,
  updateResultCount,
} from './strip-to-results.js';

/**
 * 永页机的消息标识。
 * 官方文档里正文写作 'pagetual'，但示例代码中出现过 'patetual' 的拼写，
 * 两种都接受，避免因为它笔误而失联。
 */
const PAGETUAL_COMMANDS = new Set(['pagetual', 'patetual']);

/**
 * 永页机自己绘制的「Page N」分隔条。
 *
 * 它与结果容器**不是同一个节点**（`createPageBar()` 把它作为独立兄弟节点
 * 插在同一位置），所以只收纳结果容器会留下完整的「Page 2」分隔条。
 * 它不承载结果数据，纯粹是原站版面残片，一并收纳。
 */
const PAGE_BAR_SELECTOR = '.pagetual_pageBar';

/**
 * 变化合并窗口。一次插入会引发多次 DOM 变更，
 * 逐次处理既浪费又可能采到中间状态。
 */
const SETTLE_MS = 200;

let observer: MutationObserver | null = null;
let listener: ((event: MessageEvent) => void) | null = null;
let rerenderListener: (() => void) | null = null;
let timer = 0;
let engine: EngineAdapter | null = null;
/** 是否已因协同而追加过内容（用于只提示一次） */
let appendedOnce = false;
/** 是否已提示过「插入内容已转入数据源」 */
let relocatedOnce = false;

export const pagetualBridge: Feature = {
  id: 'pagetual-bridge',
  name: '永页机协同',
  description: '自动翻页脚本加载的新页内容，按本页样式追加显示。',
  engines: 'all',

  supports() {
    return true;
  },

  onNavigate(ctx) {
    start(ctx.engine);
  },

  dispose() {
    stop();
  },
};

/** 挂上监听（幂等） */
function start(eng: EngineAdapter): void {
  engine = eng;

  const source = document.getElementById(SOURCE_ID);
  if (!source) {
    // 没有隐藏数据源就无从协同（例如页面尚未重写）
    log.info('未找到隐藏数据源，永页机协同未启用');
    return;
  }

  if (observer) return; // 已在监听

  /*
   * 观察整棵 body，而不是只观察 `#se-source`。
   *
   * `#se-source` 只是「数据源」在桌面端的那一半 —— 手机端永页机把新页
   * 插到它外面，只盯那一个元素会漏掉全部新内容。
   * body 尚未存在时退回 documentElement（重写完成时 body 一定在，
   * 这里只是防御）。
   */
  const root = document.body ?? document.documentElement;
  observer = new MutationObserver(onMutations);
  observer.observe(root, { childList: true, subtree: true });

  listener = (event: MessageEvent): void => {
    const data = event.data as { command?: string; action?: string } | null;
    if (!data || typeof data !== 'object') return;
    if (!data.command || !PAGETUAL_COMMANDS.has(data.command)) return;

    if (data.action === 'insert') {
      schedule();
    } else if (data.action === 'lastPage') {
      log.info('永页机：已到最后一页');
    }
  };
  window.addEventListener('message', listener);

  /*
   * 列表被整表重建（过滤规则改动）后补采一次。
   *
   * 重建只覆盖首次重写的结果，永页机后来追加的页会暂时消失；
   * 但数据源里它们还在，重新采一次即可回到列表末尾。
   */
  rerenderListener = (): void => schedule();
  document.addEventListener(RESULTS_RERENDERED_EVENT, rerenderListener);

  log.info('永页机协同已启用');
}

/** 停止监听并清理 */
function stop(): void {
  observer?.disconnect();
  observer = null;
  if (listener) window.removeEventListener('message', listener);
  listener = null;
  if (rerenderListener) document.removeEventListener(RESULTS_RERENDERED_EVENT, rerenderListener);
  rerenderListener = null;
  window.clearTimeout(timer);
  timer = 0;
  appendedOnce = false;
  relocatedOnce = false;
}

/**
 * 只做一件事：判断这批变化里有没有「原站结果内容」，有就排一次归拢。
 *
 * ⚠️ 这里刻意**不再决定「该搬到哪、该不该隐藏」**。
 * 早期版本按 mutation 节点的位置分流（在 `#se-root` 内就搬、在页面外就收纳），
 * 真机结果却是「内容采集到了，但原版块仍留在页面上」——
 * 永页机的插入方式与落点随版本、布局变化，靠猜某个分支必然漏。
 *
 * 现在改为**先记账、后归拢**：只要可能涉及结果就 schedule；
 * 统一的归拢在 `sync()` 开头做一次全量扫描（见 `sweepVisibleResults`）。
 */
function onMutations(records: MutationRecord[]): void {
  if (!engine) return;

  let relevant = false;
  outer: for (const record of records) {
    for (const node of Array.from(record.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (isOwnUi(node)) continue; // 我们自己的条目 / 直答区
      if (node.closest(`#${SOURCE_ID}`)) {
        relevant = true; // 桌面端路径：新页进了数据源
        break outer;
      }
      if (containsSourceResults(node)) {
        relevant = true;
        break outer;
      }
      if (node.matches(PAGE_BAR_SELECTOR) || node.querySelector(PAGE_BAR_SELECTOR) !== null) {
        relevant = true;
        break outer;
      }
    }
  }

  if (relevant) schedule();
}

/** 新增节点是否属于本脚本自己的界面（我们的条目 / 直答区） */
function isOwnUi(node: Element): boolean {
  return node.closest('.se-item') !== null || node.closest('.se-extra') !== null;
}

/**
 * 把所有「仍然可见的原站结果」收进数据源容器。
 *
 * 全量、幂等、**不依赖插入方式与落点** —— 只问一句
 * 「页面上还有没有不属于我们的原站结果条目」，有就搬走。
 * 判定收敛成这一句之后，永页机怎么插、插到哪都不影响结果，
 * 也就不会再出现「采到了但原版还在」这种半吊子状态。
 *
 * 两件事顺手做掉：
 *   - 条目所在的**结果容器**（`ol` / `#b_results` 一类）整块搬，
 *     免得页面上留下一个空壳占位；
 *   - 它的「Page N」分页条一并收走（纯装饰）。
 */
function sweepVisibleResults(): void {
  if (!engine) return;
  const source = document.getElementById(SOURCE_ID);
  if (!source) return;

  let moved = 0;

  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(engine.resultItemSelector),
  )) {
    if (item.closest(`#${SOURCE_ID}`)) continue; // 已在数据源里
    if (isOwnUi(item)) continue; // 我们自己的条目

    const target = pickResultsHost(item) ?? item;
    if (target === source) continue;
    if (source.contains(target) || target.contains(source)) continue;
    source.appendChild(target);
    moved++;
  }

  for (const bar of Array.from(document.querySelectorAll<HTMLElement>(PAGE_BAR_SELECTOR))) {
    if (bar.closest(`#${SOURCE_ID}`)) continue;
    source.appendChild(bar);
    moved++;
  }

  if (moved > 0 && !relocatedOnce) {
    relocatedOnce = true;
    log.warn('[永页机协同] 已把新页内容归入数据源');
  }
}

/**
 * 找条目所属的「结果容器」，能整块搬走时返回它。
 *
 * 只往上爬三层，且一旦发现该节点包含我们的界面就立刻放弃 ——
 * 宁可只搬条目本身，也绝不能把 `#se-root` / `.se-list` 搬进 1px 容器。
 * 这也是为什么不能按「最外层容器」取：往上多爬一层就可能把整个界面带走。
 */
function pickResultsHost(item: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = item.parentElement;
  for (let depth = 0; node && depth < 3; depth++) {
    if (node === document.body || node === document.documentElement) return null;
    if (node.querySelector('#se-root, .se-list, .se-item') !== null) return null;
    if (node.matches('ol, ul, #b_results, .b_results')) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 新增节点里是否有原站结果条目或结果容器。
 *
 * ⚠️ 这里**不再排除 `#se-root`**：手机端永页机会把新页插进我们的界面内部
 * （它把可见的 `ol.se-list` 当成了结果容器）。排除根容器会让这些内容
 * 既采不到也不收纳，正是「拼入内容没被渲染成自定义样式」的成因。
 * 我们自己的条目由 `isOwnUi()` 在更早一步识别并跳过。
 */
function containsSourceResults(node: Element): boolean {
  if (!engine) return false;

  return (
    node.matches(engine.resultContainerSelector) ||
    node.matches(engine.resultItemSelector) ||
    node.querySelector(engine.resultContainerSelector) !== null ||
    node.querySelector(engine.resultItemSelector) !== null
  );
}

/** 合并短时间内的多次变化，统一处理一次 */
function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(sync, SETTLE_MS);
}

/** 把数据源里新增的结果追加到可见列表 */
function sync(): void {
  if (!engine) return;

  const list = document.querySelector<HTMLElement>('.se-list');
  if (!list) return;

  /*
   * 先归拢、后采集。
   *
   * 顺序不能反：归拢把页面上可见的原版内容搬进数据源，
   * 紧接着的采集才能读到它们；若先采集，这一轮只会看到
   * 「已经搬进去的旧内容」，新插入的那一页要等下一轮。
   *
   * 这一步也承担「把原版块从页面上抹掉」的职责 ——
   * 只采集不归拢，就是用户看到的「内容渲染出来了，原版还留在下面」。
   */
  sweepVisibleResults();

  const fresh = collectUnrendered(list);
  if (fresh.length === 0) return;

  const rendered = list.querySelectorAll('.se-item').length;
  /*
   * 序号续上：列表已有条数 + 当前页的全局起点。
   * 第二页（first=9、每页 8 条）拼进来时，第一条是第 9 条结果 ——
   * 与标题栏的「第 2 页」、以及本页自身的序号口径一致。
   */
  list.append(...buildResultItems(fresh, getResultStartIndex() + rendered));
  updateResultCount(rendered + fresh.length);

  if (!appendedOnce) {
    appendedOnce = true;
    log.warn('[永页机协同] 已接管自动加载的内容，后续新页会按本页样式追加');
  }
  log.warn(`[永页机协同] 追加 ${fresh.length} 条，累计 ${rendered + fresh.length} 条`);
}

/**
 * 取出数据源里「尚未渲染过」的结果。
 *
 * 数据源就是 `#se-source` —— 桌面端的新页本来就插在里面，
 * 手机端的新页则被 `sweepVisibleResults()` 搬了进来。
 * 这里仍按条目而非固定容器定位，因为搬进来的块结构五花八门。
 *
 * 之所以按 URL 去重而不是按条数差：永页机是插入**新的容器**，
 * 容器数量与顺序都可能变，条数差会随之错位；
 * 而「这条结果的地址是否已出现过」是稳定的判据。
 */
function collectUnrendered(list: HTMLElement): SearchResult[] {
  if (!engine) return [];

  /*
   * 数据源按「原站结果条目的父元素」来定位，而不是按固定的容器选择器。
   *
   * 容器选择器（`#b_results`）在桌面端成立，但手机端永页机插入的容器
   * 未必叫这个名字；只要出现了 `li.b_algo`，它就有父元素可采。
   * 这样"容器叫什么、插在哪里"都不再是采集的前提 ——
   * 这是手机端能跑通的关键。
   *
   * 同样**不排除 `#se-root`**：永页机可能把内容直接插进我们的列表。
   * 我们自己的条目不匹配 `resultItemSelector`（`.se-item` 里没有
   * `li.b_algo`），不会误采；真的插进根内的原站条目本来就该被接管。
   */
  const hosts: HTMLElement[] = [];
  const seenHosts = new Set<Element>();
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(engine.resultItemSelector),
  )) {
    if (isOwnUi(item)) continue;
    const host = item.parentElement;
    if (!host || seenHosts.has(host)) continue;
    seenHosts.add(host);
    hosts.push(host);
  }

  /*
   * 已渲染的地址取 `dataset.seHref` 而不是链接元素的 href。
   *
   * 被 hide 规则命中的条目会**摘掉 href**（占位条不是链接），
   * 只看 DOM 里的 href 会让它们的地址被当成「没渲染过」，
   * 于是每轮 sync 都把它们重新采出来、重复追加一遍。
   * `dataset.seHref` 是构建条目时无论如何都会留下的原始地址。
   */
  const seen = new Set<string>();
  for (const item of Array.from(list.querySelectorAll<HTMLElement>('.se-item'))) {
    const recorded = item.dataset.seHref;
    if (recorded) seen.add(recorded);
    // 兜底：万一某条没写 dataset（例如早前版本渲染的节点）
    const hitHref = item.querySelector<HTMLAnchorElement>('.se-hit')?.getAttribute('href');
    if (hitHref) seen.add(hitHref);
  }

  const out: SearchResult[] = [];
  for (const host of hosts) {
    for (const result of engine.extractResults(host)) {
      const url = result.url ?? result.link?.href ?? '';
      if (url !== '' && seen.has(url)) continue;
      if (url !== '') seen.add(url);
      out.push(result);
    }
  }
  return out;
}

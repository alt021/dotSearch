/**
 * 加载更多（脚本内的拼页）
 *
 * 取代原站页码栏与第三方自动翻页脚本：结果列表末尾放一个
 * 「SHOW MORE」按钮，每次取下一页的结果追加到当前列表。
 *
 * ## 为什么自己抓取，而不是跳转到下一页
 *
 * 跳转会让用户失去已经读到的位置，也意味着页码栏必须存在。
 * 抓取同一站点的下一页 HTML、解析成结构化结果后追加，才能做到
 * 「一条连续的结果流」。地址栏保持不变，刷新会回到第一页 ——
 * 这与用户对「加载更多」的直觉一致。
 *
 * ## 上限
 *
 * 单次检索最多加载 100 条（含首屏）。手动点击与自动加载共用同一个上限，
 * 否则自动模式下用户一滚到底就会无限请求。
 *
 * ## 自动加载
 *
 * 设置项开启时，按钮进入视口即触发一次加载；加载完成后再检查一次
 * 按钮是否仍在视口内，若在则继续 —— 直到按钮被新内容挤出视口、
 * 没有更多结果，或达到上限。
 */
import type { Feature } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import { log } from '../core/env.js';
import { isAutoLoadMoreEnabled } from './settings-store.js';
import {
  LIST_ID,
  PAGINATION_UPDATED_EVENT,
  appendResults,
  buildPageUrl,
  getLoadedResultCount,
  getPaginationState,
} from './strip-to-results.js';

/** 按钮容器类名（同时是「页面重写完整」的判据，见 strip-to-results） */
export const MORE_CLASS = 'se-more';

/** 按钮类名 */
export const MORE_BUTTON_CLASS = 'se-more-button';

/** 单次检索最多加载的结果条数 */
export const MAX_TOTAL_RESULTS = 100;

const LABEL = 'SHOW MORE';
const LOADING_LABEL = 'LOADING…';

/** 自动加载时按钮进入视口的提前量：快到底部就开始取，避免出现空档 */
const VIEWPORT_MARGIN = 300;

let engine: EngineAdapter | null = null;
let container: HTMLElement | null = null;
let button: HTMLButtonElement | null = null;
let observer: IntersectionObserver | null = null;
let paginationListener: (() => void) | null = null;
let controller: AbortController | null = null;
let autoTimer = 0;
/** 下一次要抓取的页号 */
let nextPage = 2;
let loading = false;
let hasMore = false;
let exhausted = false;

export const loadMore: Feature = {
  id: 'load-more',
  name: '加载更多',
  description: '在结果列表末尾追加下一页结果，不再跳转页码。',
  /*
   * 目前只有必应的分页参数（first=）被接进了 buildPageUrl。
   * Google / 百度的偏移参数不同，适配后再放开。
   */
  engines: ['bing'],

  supports() {
    return true;
  },

  onNavigate(ctx) {
    teardown();

    const list = document.getElementById(LIST_ID);
    if (!list) return;

    engine = ctx.engine;
    const state = getPaginationState();
    nextPage = state.pageNumber + 1;

    const total = getLoadedResultCount();
    /*
     * 初始是否显示按钮：
     *   - 原站明确给出了后面的页 → 显示；
     *   - 原站没给线索，但当前页是满的 → 大概率还有下一页，也显示。
     * 后者覆盖 www 版「分页晚渲染、线索缺失」的情况；若抓回来是空页，
     * 按钮会自行消失。
     */
    hasMore = total > 0 && total < MAX_TOTAL_RESULTS;
    hasMore &&= state.maxPage > state.pageNumber || total >= state.pageSize;

    mount(list);
    syncVisibility();
    bindPaginationUpdates();
  },

  dispose() {
    teardown();
  },
};

/** 挂上按钮（结果列表之后） */
function mount(list: HTMLElement): void {
  container = document.createElement('div');
  container.className = MORE_CLASS;

  button = document.createElement('button');
  button.type = 'button';
  button.className = MORE_BUTTON_CLASS;
  button.textContent = LABEL;
  button.setAttribute('aria-label', '加载更多结果');
  button.addEventListener('click', () => void requestNextPage());

  container.appendChild(button);
  list.after(container);

  setupObserver();
}

/** 自动加载：按钮进入视口时触发 */
function setupObserver(): void {
  if (!button || typeof IntersectionObserver === 'undefined') return;

  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (isAutoLoadMoreEnabled()) void requestNextPage();
    },
    { rootMargin: `0px 0px ${VIEWPORT_MARGIN}px 0px` },
  );
  observer.observe(button);
}

/** 原站稍后补齐分页时，重新允许加载 */
function bindPaginationUpdates(): void {
  paginationListener = (): void => {
    if (exhausted || getLoadedResultCount() >= MAX_TOTAL_RESULTS) return;
    hasMore = true;
    syncVisibility();
    kickAuto();
  };
  document.addEventListener(PAGINATION_UPDATED_EVENT, paginationListener);
}

/** 设置里刚打开自动加载时，立刻检查按钮是否已在视口内 */
export function refreshAutoLoad(): void {
  if (!button || !hasMore) return;
  kickAuto();
}

/** 加载完成后若按钮仍在视口内且自动加载开启，继续下一批 */
function kickAuto(): void {
  if (!isAutoLoadMoreEnabled() || !hasMore || loading) return;

  window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    autoTimer = 0;
    if (!button || !button.isConnected || !hasMore) return;
    if (isAutoLoadMoreEnabled() && inViewport(button)) void requestNextPage();
  }, 200);
}

function inViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.top < window.innerHeight + VIEWPORT_MARGIN && rect.bottom > -VIEWPORT_MARGIN;
}

/** 抓取下一页并追加 */
async function requestNextPage(): Promise<void> {
  if (loading || !hasMore || exhausted || !engine) return;

  const before = getLoadedResultCount();
  if (before >= MAX_TOTAL_RESULTS) {
    stopLoading('已达到单次检索上限');
    syncVisibility();
    return;
  }

  loading = true;
  setBusy(true);

  try {
    const url = buildPageUrl(nextPage);
    controller = new AbortController();
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    /*
     * 抓回来的 HTML 里相对地址要以**该页地址**为基准解析。
     * DOMParser 生成的文档默认继承当前页的 URL，这里显式给一个 <base>，
     * 保证链接解析不会跑到错误的域上。
     */
    const base = doc.createElement('base');
    base.href = url;
    (doc.head ?? doc.documentElement).prepend(base);

    /*
     * 上限必须在这里卡住，不能只在追加后判断。
     * 每页 30 条时 90 之后还能点一次，整页追加会冲到 120 ——
     * 只取还差的那部分，保证「每次检索最多 100 条」是硬上限。
     */
    const remaining = MAX_TOTAL_RESULTS - before;
    const results = engine.extractResults(doc).slice(0, Math.max(0, remaining));
    const after = appendResults(results);
    nextPage += 1;

    if (after <= before) {
      // 没有新结果：原站已经没有下一页（或返回了重复内容）
      stopLoading('没有更多结果');
    } else if (after >= MAX_TOTAL_RESULTS) {
      stopLoading(`已达到单次检索上限（${MAX_TOTAL_RESULTS} 条）`);
    } else {
      hasMore = true;
      log.info(`[加载更多] 第 ${nextPage - 1} 页：追加 ${after - before} 条，累计 ${after} 条`);
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      // 失败不消耗页码，保持按钮可点，让用户自己决定是否重试
      log.warn('[加载更多] 抓取失败：', err);
    }
  } finally {
    controller = null;
    loading = false;
    setBusy(false);
    syncVisibility();
    kickAuto();
  }
}

/** 结束加载：隐藏按钮并记录原因 */
function stopLoading(reason: string): void {
  hasMore = false;
  exhausted = true;
  log.info(`[加载更多] ${reason}`);
}

function setBusy(busy: boolean): void {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? LOADING_LABEL : LABEL;
}

/** 按 hasMore 显示 / 隐藏按钮 */
function syncVisibility(): void {
  if (!container) return;
  container.hidden = !hasMore;
  if (hasMore && button) {
    button.disabled = loading;
    button.textContent = loading ? LOADING_LABEL : LABEL;
  }
}

function teardown(): void {
  observer?.disconnect();
  observer = null;

  window.clearTimeout(autoTimer);
  autoTimer = 0;

  controller?.abort();
  controller = null;

  if (paginationListener) {
    document.removeEventListener(PAGINATION_UPDATED_EVENT, paginationListener);
    paginationListener = null;
  }

  container?.remove();
  container = null;
  button = null;

  engine = null;
  loading = false;
  hasMore = false;
  exhausted = false;
  nextPage = 2;
}

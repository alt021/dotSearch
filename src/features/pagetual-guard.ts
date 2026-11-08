/**
 * 停用东方永页机（Pagetual）
 *
 * 本脚本现在自己做拼页：结果列表末尾的「SHOW MORE」逐页追加。
 * 再让永页机同时接管，会出现两套翻页逻辑抢同一个页面 ——
 * 它按原站结构插入新页，而这些内容既不进我们的列表，也绕过了 100 条上限。
 *
 * ## 为什么能「让它退出」
 *
 * 永页机用页面全局变量做单例保护：初始化时若发现
 * `_unsafeWindow.initedPagetual` 已有值，会直接 return。
 * 因此本脚本在 `document-start` 抢先把它置为 true（见 src/index.ts），
 * 永页机随后自己的 300ms 延时初始化就会安静退出。
 *
 * ## 抢先失败时
 *
 * 两个脚本的执行顺序由管理器决定，不保证我们一定在前。
 * 若永页机已经开始工作，这里还会：
 *   - 移除它的可见界面（侧边控制器 / Page N 分隔条 / 选择器浮层）；
 *   - 把它后来插入的原站结果条目挪回隐藏数据源，避免以原站样式
 *     混进我们的列表、或留在页面上。
 * 这些清理挂在 MutationObserver 上，插入后立刻处理。
 */
import type { Feature } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import { log } from '../core/env.js';
import { ROOT_ID, SOURCE_ID } from './strip-to-results.js';

/** 永页机的可见界面与其选择器浮层 */
const PAGETUAL_UI_SELECTORS = [
  '#pagetual-sideController',
  '#pagetual-picker',
  '.pagetual_pageBar',
] as const;

/** 合并短时间内的多次变化 */
const SETTLE_MS = 100;

let observer: MutationObserver | null = null;
let timer = 0;
let engine: EngineAdapter | null = null;
let announced = false;

/**
 * 在永页机初始化之前置位它的单例标记，让它自行退出。
 *
 * 必须在 document-start 尽早调用（见 src/index.ts）——
 * 永页机顶层代码之后会排一个约 300ms 的初始化任务。
 */
export function setPagetualOptOut(): void {
  try {
    const pageWindow =
      typeof unsafeWindow === 'undefined' ? window : (unsafeWindow as Window);
    (pageWindow as unknown as Record<string, unknown>).initedPagetual = true;
  } catch {
    /* 沙箱里拿不到页面 window 时忽略：此时也不会同时装着永页机 */
  }
}

export const pagetualGuard: Feature = {
  id: 'pagetual-guard',
  name: '停用永页机',
  description: '检测到东方永页机时使其退出，拼页由本脚本负责。',
  /*
   * 只在必应上启用：只有必应接入了「加载更多」，
   * 其它引擎若把永页机赶走就等于连翻页都没了。
   */
  engines: ['bing'],

  supports() {
    return true;
  },

  onNavigate(ctx) {
    engine = ctx.engine;
    // 兜底再置一次：功能执行时永页机可能还未初始化
    setPagetualOptOut();

    /*
     * 以「页面已被重写」为准，而不是再看 URL：
     * 设置页同样属于本引擎，却没有结果列表，不该在那里做清理。
     */
    if (!document.getElementById(ROOT_ID)) return;

    cleanNow();
    startObserver();
  },

  dispose() {
    stopObserver();
  },
};

/** 立刻清理一次（幂等） */
function cleanNow(): void {
  let removed = 0;

  for (const selector of PAGETUAL_UI_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      el.remove();
      removed++;
    }
  }

  document.body?.classList.remove('pagetual-picker');

  /*
   * 永页机后来插入的原站结果：搬回隐藏数据源。
   * 它们不进可见列表（那里的内容由 load-more 统一提供），
   * 但留在页面上会以原站样式混排，所以必须挪走。
   */
  if (engine) {
    const source = document.getElementById(SOURCE_ID);
    if (source) {
      for (const item of Array.from(
        document.querySelectorAll<HTMLElement>(engine.resultItemSelector),
      )) {
        if (item.closest(`#${SOURCE_ID}`)) continue;
        if (item.closest('.se-item')) continue;
        source.appendChild(item);
        removed++;
      }
    }
  }

  if (removed > 0 && !announced) {
    announced = true;
    log.warn('[永页机] 检测到东方永页机，已停用其界面并由本脚本接管拼页');
  }
}

function startObserver(): void {
  if (observer || !document.body) return;

  observer = new MutationObserver(() => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      cleanNow();
    }, SETTLE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  window.clearTimeout(timer);
  timer = 0;
  engine = null;
}

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
 *   - 每次变化后重新解析隐藏容器里的结果，把**新增的**追加到列表末尾
 *
 * 只追加、不重建：重建会丢掉用户的滚动位置与悬停状态。
 *
 * ## 两个容易踩错的细节
 *
 * 1. **它会插入一个新的容器，而不是往同一个容器里塞**
 *    （把新页的 `#b_results` 接在旧容器之后）。
 *    因此采集时必须遍历隐藏容器里**所有**匹配的结果容器，
 *    只查第一个会永远看不到新内容。
 *
 * 2. **靠条数差判断新增不可靠**
 *    容器被替换、重排都会让计数错位。改为按 URL 去重：
 *    只追加「地址尚未出现过」的条目。
 */
import type { Feature } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import type { SearchResult } from '../types/engine.js';
import { log } from '../core/env.js';
import { SOURCE_ID, buildResultItems, updateResultCount } from './strip-to-results.js';

/**
 * 永页机的消息标识。
 * 官方文档里正文写作 'pagetual'，但示例代码中出现过 'patetual' 的拼写，
 * 两种都接受，避免因为它笔误而失联。
 */
const PAGETUAL_COMMANDS = new Set(['pagetual', 'patetual']);

/**
 * 变化合并窗口。一次插入会引发多次 DOM 变更，
 * 逐次处理既浪费又可能采到中间状态。
 */
const SETTLE_MS = 200;

let observer: MutationObserver | null = null;
let listener: ((event: MessageEvent) => void) | null = null;
let timer = 0;
let engine: EngineAdapter | null = null;
/** 是否已因协同而追加过内容（用于只提示一次） */
let appendedOnce = false;

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

  observer = new MutationObserver(schedule);
  observer.observe(source, { childList: true, subtree: true });

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

  log.info('永页机协同已启用');
}

/** 停止监听并清理 */
function stop(): void {
  observer?.disconnect();
  observer = null;
  if (listener) window.removeEventListener('message', listener);
  listener = null;
  window.clearTimeout(timer);
  timer = 0;
  appendedOnce = false;
}

/** 合并短时间内的多次变化，统一处理一次 */
function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(sync, SETTLE_MS);
}

/** 把隐藏容器里新增的结果追加到可见列表 */
function sync(): void {
  if (!engine) return;

  const source = document.getElementById(SOURCE_ID);
  const list = document.querySelector<HTMLElement>('.se-list');
  if (!source || !list) return;

  const fresh = collectUnrendered(source, list);
  if (fresh.length === 0) return;

  const rendered = list.querySelectorAll('.se-item').length;
  list.append(...buildResultItems(fresh, rendered));
  updateResultCount(rendered + fresh.length);

  if (!appendedOnce) {
    appendedOnce = true;
    log.warn('[永页机协同] 已接管自动加载的内容，后续新页会按本页样式追加');
  }
  log.warn(`[永页机协同] 追加 ${fresh.length} 条，累计 ${rendered + fresh.length} 条`);
}

/**
 * 取出隐藏容器里「尚未渲染过」的结果。
 *
 * 之所以按 URL 去重而不是按条数差：永页机是插入**新的容器**，
 * 容器数量与顺序都可能变，条数差会随之错位；
 * 而「这条结果的地址是否已出现过」是稳定的判据。
 */
function collectUnrendered(source: HTMLElement, list: HTMLElement): SearchResult[] {
  if (!engine) return [];

  // 只看最外层的结果容器：避免容器嵌套时同一条结果被采两次
  const matched = Array.from(
    source.querySelectorAll<HTMLElement>(engine.resultContainerSelector),
  );
  const outermost = matched.filter(
    (el) => !matched.some((other) => other !== el && other.contains(el)),
  );

  const seen = new Set<string>();
  for (const hit of list.querySelectorAll<HTMLAnchorElement>('.se-item .se-hit')) {
    const href = hit.getAttribute('href');
    if (href) seen.add(href);
  }

  const out: SearchResult[] = [];
  for (const container of outermost) {
    for (const result of engine.extractResults(container)) {
      const url = result.url ?? result.link?.href ?? '';
      if (url !== '' && seen.has(url)) continue;
      if (url !== '') seen.add(url);
      out.push(result);
    }
  }
  return out;
}

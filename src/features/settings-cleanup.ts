/**
 * 设置页清理
 *
 * 在 Bing 的设置页（`/account/general`）上，把**已被本脚本取代
 * 或在本脚本下不成立**的设置项折叠起来。
 *
 * ## 为什么是「折叠并说明」而不是直接删
 *
 * 设置项凭空消失会让人以为页面坏了，或者怀疑 Bing 在偷偷改东西。
 * 保留一条可见的说明，用户才能理解是「本脚本接管了这部分」，
 * 而不是「Bing 出问题了」——而且他随时能展开看一眼原来是什么。
 *
 * ## 为什么由适配器决定隐藏什么
 *
 * 「哪个设置被取代了」本质上是引擎知识：Bing 的 `#newwnd` 是
 * 「新窗口打开」，换成 Google 就完全不是这回事。
 * 因此清单写在 `engines/bing.ts` 的 `getSupersededSettings()` 里，
 * 本模块只负责「按清单执行 + 生成说明 UI」，不含任何引擎专属选择器。
 *
 * ## 时机
 *
 * 设置页是普通文档，不是 SPA 结果页，但 Bing 的设置区块是**异步插入**的
 * （页面骨架先到、表单后到）。因此不能只跑一次 querySelector，
 * 要用 MutationObserver 等目标出现，并持续观察后续插入。
 */
import type { Feature } from '../types/feature.js';
import { log } from '../core/env.js';

/** 清理后的设置块标记类名（幂等判据） */
const HIDDEN_BLOCK_CLASS = 'se-setting-superseded';

/** 说明面板的类名 */
const NOTE_CLASS = 'se-settings-note';

/** 说明面板的宿主 id（插在设置页顶部） */
const NOTE_HOST_ID = 'se-settings-note-host';

/**
 * 等待目标元素出现。
 *
 * 只观察 `document`（而不是 documentElement）——
 * 脚本在 document-start 运行，那时 documentElement 可能还不存在。
 */
function whenPresent(
  selector: string,
  callback: (el: Element) => void,
  timeoutMs = 15000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tryNow = (): boolean => {
    const el = document.querySelector(selector);
    if (el) {
      callback(el);
      return true;
    }
    return false;
  };

  if (tryNow()) return () => {};

  const observer = new MutationObserver(() => {
    if (stopped) return;
    if (tryNow()) {
      stopped = true;
      observer.disconnect();
      if (timer) clearTimeout(timer);
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  timer = setTimeout(() => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
  }, timeoutMs);

  return () => {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}

/**
 * 折叠一个设置块。
 *
 * ## 折叠的是「内容区」，不是整个分组
 *
 * Bing 的设置页结构是：一个分组容器里左边放 `<h3>` 标题、
 * 右边放控件（`.me_subsection_r`）。如果连容器一起折叠，
 * 我们自绘的 summary 就会和原 `<h3>` 标题**重复显示**两条一样的名字
 * （实测截图里「搜索建议」出现了两次）。
 *
 * 因此这里只换掉**控件所在的那一半**，保留左侧分组标题 ——
 * 用户看到的仍是「搜索建议：此项已被取代」，而不是两行标题打架。
 */
function foldBlock(el: HTMLElement, label: string, reason: string): boolean {
  if (el.classList.contains(HIDDEN_BLOCK_CLASS)) return false;

  el.classList.add(HIDDEN_BLOCK_CLASS);

  /*
   * 找出真正承载控件的区域。
   *
   *   `.me_subsection_r`  必应左侧标题 + 右侧内容的布局
   *   否则用元素自身（例如 .b_vPanel 这种纯面板）
   */
  const content = el.querySelector<HTMLElement>('.me_subsection_r') ?? el;

  /*
   * 折叠正文：把原内容整体移进 details。
   *
   * 直接隐藏会让用户彻底失去知情权；details 让他能自己展开核对。
   * 用 details/summary 而不是自定义折叠，是为了零 JS 依赖键盘与屏幕阅读器。
   */
  const details = document.createElement('details');
  details.className = 'se-setting-fold';

  const summary = document.createElement('summary');
  summary.className = 'se-setting-fold-summary';

  const title = document.createElement('span');
  title.className = 'se-setting-fold-label';
  title.textContent = label;

  const why = document.createElement('span');
  why.className = 'se-setting-fold-reason';
  why.textContent = reason;

  summary.append(title, why);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'se-setting-fold-body';
  // 把原有内容整体搬进去，保持一切原有交互可用
  while (content.firstChild) body.appendChild(content.firstChild);
  details.appendChild(body);

  content.appendChild(details);
  return true;
}

/**
 * 在设置页顶部放一条总说明。
 */
function ensureNoteHost(count: number): void {
  if (document.getElementById(NOTE_HOST_ID)) return;

  const anchor = document.querySelector('#search-section-content, .me_sectioncontent, form');
  if (!anchor || !anchor.parentElement) return;

  const note = document.createElement('div');
  note.id = NOTE_HOST_ID;
  note.className = NOTE_CLASS;

  const text = document.createElement('p');
  text.className = 'se-settings-note-text';
  text.textContent =
    `本脚本接管了 ${count} 项搜索结果页行为，相关设置已折叠。` +
    '它们不影响脚本工作，展开可以查看原设置。';
  note.appendChild(text);

  anchor.parentElement.insertBefore(note, anchor);
}

export const settingsCleanup: Feature = {
  id: 'settings-cleanup',
  name: '设置页清理',
  description: '在搜索设置页折叠已被本脚本取代的设置项。',
  engines: 'all',

  /*
   * 只在实现了 isSettingsPage + getSupersededSettings 的引擎上运行。
   * 两者缺一就不启用 —— 否则会拿着空清单跑一遍，白费力气。
   */
  supports(engine) {
    return Boolean(engine.isSettingsPage && engine.getSupersededSettings);
  },

  onNavigate(ctx) {
    const engine = ctx.engine;
    /*
     * 用 ctx.url 而不是 location.href。
     *
     * FeatureContext 提供 url 就是为了让功能不必去读全局 ——
     * 读全局会让它在「调用方给的 URL 与地址栏不一致」的场景下判错，
     * 也会让测试无法通过传入 URL 来驱动。
     */
    if (!engine.isSettingsPage?.(ctx.url)) return;

    const list = engine.getSupersededSettings?.() ?? [];
    if (list.length === 0) return;

    log.info(`设置页清理：共 ${list.length} 项待处理`);

    let folded = 0;

    for (const item of list) {
      /*
       * 每一项都独立等待：设置区块可能分批插入，
       * 某一项迟迟不出现不该拖住其它项。
       */
      whenPresent(item.selector, (el) => {
        if (!(el instanceof HTMLElement)) return;
        if (foldBlock(el, item.label, item.reason)) {
          folded++;
          log.info(`设置页清理：已折叠「${item.label}」`);
          /*
           * 说明里的数量用**清单总数**而不是已完成数。
           * 用已完成数会让说明在同一批折叠过程中反复改写
           * （1 项 → 2 项 → 3 项），用户看到的是跳变；
           * 而清单长度从一开始就是确定的。
           */
          ensureNoteHost(list.length);
        }
      });
    }
  },
};

/** DOM 与导航相关的通用工具 */

/** 等待选择器命中，带超时。返回元素或 null（不抛错） */
export function waitForSelector<T extends Element = HTMLElement>(
  selector: string,
  { timeout = 10_000, root = document }: { timeout?: number; root?: Document | HTMLElement } = {},
): Promise<T | null> {
  const existing = root.querySelector<T>(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: T | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };

    const observer = new MutationObserver(() => {
      const el = root.querySelector<T>(selector);
      if (el) finish(el);
    });
    observer.observe(root === document ? document.documentElement : root, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => finish(null), timeout);
  });
}

/** 元素上的一次性标记，替代手动 WeakSet */
export function markOnce(el: Element, key: string): boolean {
  const flag = `__se_${key}`;
  if ((el as unknown as Record<string, unknown>)[flag]) return false;
  (el as unknown as Record<string, unknown>)[flag] = true;
  return true;
}

/**
 * 监听 SPA 导航（历史记录变化 / 前进后退）。
 * Bing、Google、百度均为无整页刷新的单页应用，
 * 换词只改 DOM 和 URL，因此功能必须挂在这里而不是 DOMContentLoaded。
 */
export function onUrlChange(handler: (url: URL) => void): () => void {
  let last = location.href;

  const notify = () => {
    if (location.href === last) return;
    last = location.href;
    handler(new URL(location.href));
  };

  // pushState / replaceState 不会触发 popstate，必须打补丁
  const { pushState, replaceState } = history;
  history.pushState = function patchedPushState(...args) {
    const result = pushState.apply(this, args);
    queueMicrotask(notify);
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = replaceState.apply(this, args);
    queueMicrotask(notify);
    return result;
  };

  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);

  return () => {
    history.pushState = pushState;
    history.replaceState = replaceState;
    window.removeEventListener('popstate', notify);
    window.removeEventListener('hashchange', notify);
  };
}

/** 归一化文本：折叠空白、去首尾空格 */
export function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 延时执行 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

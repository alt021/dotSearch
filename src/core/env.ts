const PREFIX = '[search-enhance]';
const STYLE_ID = 'search-enhance-styles';

/**
 * 调试日志开关。
 * 原先通过 Tampermonkey 菜单切换，菜单已移除，
 * 改为读取全局标志 —— 在控制台执行
 * `window.__searchEnhanceDebug__ = true` 后刷新即可看到 info 级日志。
 */
const DEBUG_FLAG = '__searchEnhanceDebug__';

export const log = {
  info(...args: unknown[]): void {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (scope[DEBUG_FLAG] !== true) return;
    console.info(PREFIX, ...args);
  },
  /** 关键诊断一律用 warn：Firefox 默认会显示，不依赖调试开关 */
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};

/**
 * 样式已排队等待插入的 id。
 *
 * 文档树还没建立时不能同步插 <style>，先记在这里；
 * 同时它兼任「已注入」判据 —— 否则 DOM 里查不到、重复调用会插两份。
 */
const pendingStyles = new Map<string, string>();

/** 最近一次注入的 CSS，供 reassertOwnStyle 在必要时重建 */
let lastStyleCss: string | null = null;

/**
 * 注入样式（幂等，重复调用不会叠加 <style>）。
 *
 * ## 为什么要容忍 document.head 不存在
 *
 * `@run-at document-start` 下脚本会在**文档树建立之前**执行：
 * 实测此刻 `document.documentElement` / `head` / `body` 三者**全为 null**，
 * `document.readyState === 'loading'`。
 * 早期版本直接 `document.head.appendChild(...)`，于是启动即抛
 * `Cannot read properties of null (reading 'appendChild')` ——
 * 样式没进去、脚本中断，且注入标记已经置位，后续重注入被当成重复而跳过，
 * 表现为「整个增强功能都没生效」。
 *
 * 因此这里分三种情况：head 在就插 head，只有 documentElement 就插它，
 * 都没有就挂起，等 documentElement 出现再补插。
 */
export function injectStyle(css: string, id: string = STYLE_ID): void {
  lastStyleCss = css;
  if (document.getElementById(id) || pendingStyles.has(id)) return;
  if (typeof GM_addStyle === 'function') {
    try {
      GM_addStyle(css);
      return;
    } catch {
      /* 回退到原生 */
    }
  }

  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;

  const host = document.head ?? document.documentElement;
  if (host) {
    host.appendChild(el);
    return;
  }

  // 文档树尚未建立：先排队，等根元素出现再插入
  pendingStyles.set(id, css);
  const observer = new MutationObserver(() => {
    const target = document.head ?? document.documentElement;
    if (!target) return;
    observer.disconnect();
    pendingStyles.delete(id);
    if (!document.getElementById(id)) target.appendChild(el);
  });
  // 观察 document 本身而不是 documentElement —— 后者此刻还是 null
  observer.observe(document, { childList: true, subtree: true });
}

/**
 * 确保我们自己的样式表仍然生效。
 *
 * 供「关掉原站样式表」之后调用。清理逻辑是按 id 排除自家样式表的，
 * 而**真实 Tampermonkey 的 GM_addStyle 不会给 <style> 带 id** ——
 * 于是那一份会被当成原站样式一并禁用，页面直接变成无样式。
 * （实测必应的 CSP 只限制 script-src，没有 style-src，
 *   所以自己建 <style> 完全可行，也就不必迁就 GM_addStyle 的实现细节。）
 *
 * 判据：能找到带 id 的、且未被禁用的样式表就什么都不做；
 * 否则重建一份。
 */
export function reassertOwnStyle(): void {
  if (!lastStyleCss) return;
  // getElementById 给的是 HTMLElement，而这个 id 只可能是我们自己插的 <style>
  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (existing && !existing.disabled) return;
  existing?.remove();

  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = lastStyleCss;
  const host = document.head ?? document.documentElement;
  if (host) host.appendChild(el);
}

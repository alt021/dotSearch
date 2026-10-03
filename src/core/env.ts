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

/** 注入样式（幂等，重复调用不会叠加 <style>） */
export function injectStyle(css: string, id: string = STYLE_ID): void {
  if (document.getElementById(id)) return;
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
  document.head.appendChild(el);
}

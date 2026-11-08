/**
 * UserScript 注入的 GM 全局 API 声明。
 *
 * 只声明项目真正用到的能力，避免引入 @types/greasemonkey 全套。
 * 该文件不含 import/export，因此是全局脚本，声明对整个项目可见。
 */

/** 各脚本管理器在沙箱内注入的实际全局变量 */
interface GMGlobals {
  GM_getValue<T>(key: string, defaultValue: T): T;
  GM_setValue(key: string, value: unknown): void;
  GM_addStyle(css: string): void;
  GM_registerMenuCommand(caption: string, fn: () => void): string;
  GM_openInTab(url: string, options?: { active?: boolean; insert?: boolean }): void;
}

declare var GM_getValue: GMGlobals['GM_getValue'];
declare var GM_setValue: GMGlobals['GM_setValue'];
declare var GM_addStyle: GMGlobals['GM_addStyle'];
declare var GM_registerMenuCommand: GMGlobals['GM_registerMenuCommand'];
declare var GM_openInTab: GMGlobals['GM_openInTab'];

/**
 * 页面上下文的 window（需 @grant unsafeWindow）。
 *
 * 只用于置位 `initedPagetual`，让东方永页机自行退出 ——
 * 它的单例标记挂在页面 window 上，沙箱内的 window 写不到那里。
 * 未授权时读取会抛 ReferenceError，调用方用 typeof 守卫。
 */
declare var unsafeWindow: Window & typeof globalThis;

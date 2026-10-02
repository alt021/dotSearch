/** UserScript 内部使用的最小 GM API 契约。
 * 只声明项目真正用到的能力，避免依赖 @types/greasemonkey。 */
declare namespace GM {
  function getValue<T>(key: string, defaultValue: T): T;
  function setValue(key: string, value: unknown): void;
  function addStyle(css: string): HTMLStyleElement | void;
  function registerMenuCommand(caption: string, fn: () => void): string;
  function openInTab(url: string, options?: { active?: boolean; insert?: boolean }): void;
}

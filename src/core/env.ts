import type { Feature } from '../types/feature.js';

const PREFIX = '[search-enhance]';
const STYLE_ID = 'search-enhance-styles';

let debugMode = false;

/** 读取 GM 值；GM 不可用时（如直接在控制台调试）回退到 localStorage */
function readSetting<T>(key: string, fallback: T): T {
  try {
    if (typeof GM_getValue === 'function') return GM_getValue<T>(key, fallback);
  } catch {
    /* 落到 localStorage */
  }
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: unknown): void {
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
      return;
    }
  } catch {
    /* 落到 localStorage */
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略写入失败 */
  }
}

export const log = {
  setDebug(on: boolean) {
    debugMode = on;
  },
  info(...args: unknown[]) {
    if (debugMode) console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]) {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]) {
    console.error(PREFIX, ...args);
  },
};

/**
 * 功能开关存储
 * 结构：{ featureId: boolean }；未出现过则取 Feature.defaultEnabled。
 */
export class SettingsStore {
  private cache: Record<string, boolean> | null = null;
  private readonly key = 'search-enhance:features';

  private load(): Record<string, boolean> {
    this.cache ??= readSetting<Record<string, boolean>>(this.key, {});
    return this.cache;
  }

  isEnabled(feature: Feature): boolean {
    return this.load()[feature.id] ?? feature.defaultEnabled;
  }

  setEnabled(feature: Feature, enabled: boolean): void {
    const data = this.load();
    data[feature.id] = enabled;
    writeSetting(this.key, data);
    log.info(`功能开关更新：${feature.id} = ${enabled}`);
  }

  toggle(feature: Feature): boolean {
    const next = !this.isEnabled(feature);
    this.setEnabled(feature, next);
    return next;
  }
}

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

/** 注册 Tampermonkey 菜单项；GM 不可用时静默跳过 */
export function registerMenu(caption: string, fn: () => void): void {
  if (typeof GM_registerMenuCommand !== 'function') return;
  try {
    GM_registerMenuCommand(caption, fn);
  } catch (err) {
    log.warn('注册菜单失败：', caption, err);
  }
}

/** 在新标签页打开（Bing 搜索结果链接默认走新标签更顺手） */
export function openInNewTab(url: string, active = false): void {
  if (typeof GM_openInTab === 'function') {
    GM_openInTab(url, { active, insert: true });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export { readSetting, writeSetting };

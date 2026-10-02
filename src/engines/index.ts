import type { EngineAdapter } from '../types/engine.js';
import { bing } from './bing.js';
import { google } from './google.js';
import { baidu } from './baidu.js';

/**
 * 引擎注册表
 *
 * `enabled: false` 的引擎不参与匹配 —— 对应的 @match 规则
 * 也应保持在 src/meta.ts 的 MATCHES_FUTURE 中（注释状态）。
 */
const REGISTRY: Array<{ adapter: EngineAdapter; enabled: boolean }> = [
  { adapter: bing, enabled: true },
  { adapter: google, enabled: false },
  { adapter: baidu, enabled: false },
];

export const activeEngines: EngineAdapter[] = REGISTRY.filter((r) => r.enabled).map((r) => r.adapter);

/** 根据当前 URL 找出应生效的引擎；不是任何已启用引擎的搜索页则返回 null */
export function detectEngine(url: URL): EngineAdapter | null {
  return activeEngines.find((engine) => engine.isSearchPage(url)) ?? null;
}

export { bing, google, baidu };

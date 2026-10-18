import type { EngineAdapter } from '../types/engine.js';
import { bing } from './bing.js';
import { google } from './google.js';
import { baidu } from './baidu.js';

/**
 * 引擎注册表
 *
 * 项目已改为**每个引擎一个独立产物**：构建时通过 `--engine=<id>`
 * 决定把哪个适配器打进这一份脚本（见 src/index.ts 的 __SE_TARGET_ENGINE__）。
 *
 * 因此 `enabled` 现在表达的是「**是否产出该引擎的脚本**」，
 * 而不是「是否参与运行时匹配」：
 *   - true  → 该引擎有可用的适配器，`npm run build -- --engine=all` 会产出它；
 *   - false → 骨架尚未实测校准，不产出产物（避免给出一个装了就坏的脚本）。
 *
 * @match 与之对应：产出哪个引擎，就在 src/meta.ts 的 ENGINE_BUILDS 里
 * 声明它自己的注入规则。两者由同一份构建参数驱动，不会脱节。
 */
const REGISTRY: Array<{ adapter: EngineAdapter; enabled: boolean }> = [
  { adapter: bing, enabled: true },
  { adapter: google, enabled: false },
  { adapter: baidu, enabled: false },
];

export const activeEngines: EngineAdapter[] = REGISTRY.filter((r) => r.enabled).map((r) => r.adapter);

/** 全部已注册适配器（含未启用的），供调试与构建期校验 */
export const allEngines: EngineAdapter[] = REGISTRY.map((r) => r.adapter);

/** 根据当前 URL 找出应生效的引擎；不是任何已启用引擎的搜索页则返回 null */
export function detectEngine(url: URL): EngineAdapter | null {
  return activeEngines.find((engine) => engine.isSearchPage(url)) ?? null;
}

export { bing, google, baidu };

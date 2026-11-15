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
 * 注册表按构建期常量裁剪，而不是「全部 import、运行时 filter」——
 * 后者会把其它引擎的适配器代码也带进产物：Google 版里留着 Bing 的
 * 账户判据与 Rewards、Bing 版里留着 Google 的域名规则。功能上虽然
 * 不会触发，但发布物里不该出现用户明确不要的能力，搜索/审计也说不清。
 *
 * @match 与之对应：产出哪个引擎，就在 src/meta.ts 的 ENGINE_BUILDS 里
 * 声明它自己的注入规则。两者由同一份构建参数驱动，不会脱节。
 */
declare const __SE_TARGET_ENGINE__: string;

const REGISTRY: EngineAdapter[] = [
  ...(__SE_TARGET_ENGINE__ === 'bing' ? [bing] : []),
  ...(__SE_TARGET_ENGINE__ === 'google' ? [google] : []),
  ...(__SE_TARGET_ENGINE__ === 'baidu' ? [baidu] : []),
];

export const activeEngines: EngineAdapter[] = REGISTRY;

/** 根据当前 URL 找出应生效的引擎；不是任何已启用引擎的搜索页则返回 null */
export function detectEngine(url: URL): EngineAdapter | null {
  return activeEngines.find((engine) => engine.isSearchPage(url)) ?? null;
}

export { bing, google, baidu };

import type { EngineAdapter, EngineId } from './engine.js';

/** 功能模块执行时拿到的上下文 */
export interface FeatureContext {
  engine: EngineAdapter;
  /** 当前页面的搜索词 */
  query: string;
  url: URL;
}

/**
 * 一个「体验增强功能」
 *
 * 生命周期：
 *   supports()   判断是否在当前引擎上生效（不生效则跳过）
 *   onNavigate() 每次导航/换词后执行（需自行做幂等）
 *   dispose()    引擎切换或脚本卸载时清理副作用
 *
 * 所有功能常驻启用：原先的开关机制随 Tampermonkey 菜单一并移除，
 * 因此不再有 defaultEnabled / 启用状态的概念。
 */
export interface Feature {
  /** 稳定 ID，用于日志定位，勿随意修改 */
  readonly id: string;
  /** 展示名（日志用） */
  readonly name: string;
  /** 一句话说明这个功能做什么 */
  readonly description: string;
  /** 作用的引擎；'all' 表示所有已适配引擎 */
  readonly engines: EngineId[] | 'all';

  supports(engine: EngineAdapter): boolean;
  onNavigate(ctx: FeatureContext): void | Promise<void>;
  dispose?(): void;

  /**
   * 页面已被本功能改写过时，是否需要重新执行。
   *
   * 存在的理由：浏览器可能从 bfcache 恢复页面，
   * 此时改写后的 DOM 会被一并恢复，但内容完整性不保证
   * （曾出现恢复后分页缺失的情况）。
   *
   * 返回 undefined 表示不参与该判断，Runner 会按「跳过」处理。
   */
  needsRebuild?(engine: EngineAdapter): boolean | undefined;
}

export type { EngineAdapter, EngineId } from './engine.js';

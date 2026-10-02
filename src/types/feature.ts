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
 */
export interface Feature {
  /** 稳定 ID，用于设置持久化，勿随意修改 */
  readonly id: string;
  /** 展示名（菜单与日志用） */
  readonly name: string;
  /** 一句话说明这个功能做什么 */
  readonly description: string;
  /** 作用的引擎；'all' 表示所有已适配引擎 */
  readonly engines: EngineId[] | 'all';
  /** 默认是否开启 */
  readonly defaultEnabled: boolean;

  supports(engine: EngineAdapter): boolean;
  onNavigate(ctx: FeatureContext): void | Promise<void>;
  dispose?(): void;
}

export type { EngineAdapter, EngineId } from './engine.js';

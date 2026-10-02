import { ENGINE_IDS } from '../meta.js';

/** 引擎标识由 meta.ts 的 ENGINE_IDS 推导，避免两处维护 */
export type EngineId = (typeof ENGINE_IDS)[number];

/** 从搜索结果页提取出的一条结果 */
export interface SearchResult {
  /** 结果节点本身 */
  node: HTMLElement;
  /** 标题链接 */
  link: HTMLAnchorElement | null;
  /** 标题文本 */
  title: string;
  /** 摘要文本 */
  snippet: string;
  /** 结果在页面中的序号（0 起） */
  index: number;
}

/**
 * 搜索引擎适配器
 *
 * 每个引擎实现这一组方法，上层的「功能模块」只依赖此接口，
 * 因此新增引擎 = 新增一个 engines/*.ts 文件 + 在 engines/index.ts 注册。
 */
export interface EngineAdapter {
  readonly id: EngineId;
  /** 展示名 */
  readonly name: string;
  /** 该引擎搜索结果页的主机名（用于日志与调试） */
  readonly hostnames: readonly string[];

  /** 当前 URL 是否是该引擎的搜索结果页 */
  isSearchPage(url: URL): boolean;

  /** 从 URL 中取出搜索关键词；非搜索页返回 null */
  parseQuery(url: URL): string | null;

  /** 结果列表容器选择器，waitFor 的观察目标 */
  readonly resultContainerSelector: string;

  /** 单条结果节点选择器 */
  readonly resultItemSelector: string;

  /** 广告 / 推广位节点选择器（需实测校准） */
  getAdSelectors(): string[];

  /**
   * 提取结果列表。应在 resultContainerSelector 命中后调用。
   * 允许引擎自行处理自身 DOM 差异。
   */
  extractResults(root: ParentNode): SearchResult[];

  /** 该文档中是否已注入过本脚本（防止 SPA 重复注入） */
  isAlreadyInjected(doc: Document): boolean;
  markInjected(doc: Document): void;
}

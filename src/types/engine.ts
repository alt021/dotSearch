import { ENGINE_IDS } from '../meta.js';

/** 引擎标识由 meta.ts 的 ENGINE_IDS 推导，避免两处维护 */
export type EngineId = (typeof ENGINE_IDS)[number];

/** 从搜索结果页提取出的一条结果 */
export interface SearchResult {
  /** 结果节点本身 */
  node: HTMLElement;
  /** 标题链接（可能是引擎的跳转地址） */
  link: HTMLAnchorElement | null;
  /** 标题文本 */
  title: string;
  /** 摘要文本 */
  snippet: string;
  /** 引擎展示用的可读来源 URL（便于展示，不用于跳转） */
  displayUrl: string;
  /** 解析后的真实目标地址；解析失败时回退为原始 href */
  url: string | null;
  /** 结果在页面中的序号（0 起） */
  index: number;
}

/**
 * 搜索引擎适配器
 *
 * 每个引擎实现这一组方法，上层的「功能模块」只依赖此接口，
 * 因此新增引擎 = 新增一个 engines/<id>.ts 文件 + 一个构建目标。
 *
 * ## 为什么要有「可选钩子」
 *
 * 各引擎的账户体系、菜单入口、会话判据差异极大：
 * Bing 有 Microsoft 账户、Rewards、`#id_a`/`#id_l`/`#id_p` 这类顶栏判据；
 * Google 是另一套（头像、登录端点都不同）；百度又是另一套。
 * 早期这些 Bing 专有逻辑直接写在 features/ 里，
 * 结果 features 反向依赖了 bing-session —— 接新引擎时无处安放。
 *
 * 现在把它们收敛成**可选成员**：
 *   - 引擎实现了，功能模块就用；
 *   - 没实现，功能模块自动跳过对应 UI，而不是报错或渲染空壳。
 * 这样 features/ 不再需要知道任何具体引擎的名字。
 */
export interface EngineAdapter {
  readonly id: EngineId;
  /** 展示名。同时用于产物命名与脚本头（如「Bing」→ dotSearch for Bing） */
  readonly name: string;
  /** 该引擎搜索结果页的主机名（用于日志与调试） */
  readonly hostnames: readonly string[];

  /** 当前 URL 是否是该引擎的搜索结果页 */
  isSearchPage(url: URL): boolean;

  /** 从 URL 中取出搜索关键词；非搜索页返回 null */
  parseQuery(url: URL): string | null;

  /** 搜索页的路径与查询参数名，用于重建搜索框（例：{ path: '/search', param: 'q' }） */
  readonly searchForm: { path: string; param: string };

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
  /**
   * 撤销注入标记。
   *
   * 启动过程若中途失败，必须把标记清掉 —— 否则这个文档会被永久
   * 判定为「已注入」，后续任何重试（S 换词、验证脚本重注入）都被挡在门外，
   * 表现为「整个增强功能一直不生效且没有任何补救机会」。
   */
  unmarkInjected(doc: Document): void;

  /* ---------------------------------------------------------------------
   * 以下为**可选**的引擎专有能力。未实现时相关 UI 自动跳过。
   * ------------------------------------------------------------------- */

  /**
   * 采集当前页面的账户会话状态。
   *
   * ⚠️ **必须在重写清空 DOM 之前调用**（由 strip-to-results 负责）：
   * 判据通常位于顶栏，而顶栏会被重写移除。
   */
  captureSession?(): void;

  /** 读取已采集的会话状态；未采集过应返回「未登录」 */
  getSession?(): EngineSession;

  /**
   * 菜单里的账户条目。
   *
   * 返回 null 表示当前不应展示（例如隐私模式开启、或该引擎没有账户概念）。
   * 由引擎自己决定文案与去向，功能模块只负责渲染。
   */
  getAccountEntry?(): MenuEntry | null;

  /**
   * 菜单里的「站内功能入口」组（如 Rewards、搜索设置）。
   * 缺省表示该引擎没有这类入口。
   */
  getExtraEntries?(): MenuEntry[];

  /* ---------------------------------------------------------------------
   * 设置页清理
   * ------------------------------------------------------------------- */

  /**
   * 当前 URL 是否是该引擎的**设置页**（如 Bing 的 /account/general）。
   * 缺省表示该引擎没有设置页概念，清理功能自动跳过。
   */
  isSettingsPage?(url: URL): boolean;

  /**
   * 设置页里**已被本脚本取代或失效**的项。
   *
   * 每项给出：一个用于定位的 CSS 选择器（命中该设置所在的整行/整块），
   * 以及给用户看的一句原因。脚本会把这些块隐藏，
   * 但保留一个可展开的说明，告诉用户「为什么它不见了」。
   *
   * 为什么不直接删掉：
   * 设置项凭空消失会让人以为页面坏了。写明原因，
   * 用户才能理解是「本脚本接管了」，而不是「Bing 出问题」。
   */
  getSupersededSettings?(): SupersededSetting[];
}

/**
 * 一条被脚本取代的设置项。
 */
export interface SupersededSetting {
  /** 定位该设置所在整块的选择器（应覆盖标题 + 控件，而不是只命中 input） */
  selector: string;
  /** 该设置的名称，用于说明文字 */
  label: string;
  /** 为什么它已失效/被取代 */
  reason: string;
}

/** 账户会话状态（各引擎自行解释其含义） */
export interface EngineSession {
  /** 是否已登录 */
  signedIn: boolean;
  /** 已登录时的显示名；取不到则为 null */
  name: string | null;
}

/** 一条菜单入口 */
export interface MenuEntry {
  label: string;
  href: string;
}

/**
 * 运行时调度
 *
 * 职责：识别当前引擎 → 在其搜索页上依次执行各功能。
 * 所有功能常驻启用 —— 原先的开关机制（Tampermonkey 菜单）已移除。
 * 具体功能实现见 src/features/，引擎差异见 src/engines/。
 */
import type { Feature, FeatureContext } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import { injectStyle, log } from './env.js';
import { onUrlChange, waitForSelector } from './dom.js';
import { detectEngine } from '../engines/index.js';
import { ALL_FEATURES } from '../features/index.js';
import css from '../styles/base.css';

export class Runner {
  private engine: EngineAdapter | null = null;
  private readonly active = new Set<Feature>();
  private readonly disposers: Array<() => void> = [];
  private cssInjected = false;

  /**
   * 首次启动：确定引擎、建立导航监听、执行功能
   *
   * @param options.target 本产物的专属引擎（构建期指定）。
   *   给定后只考虑这一个引擎，非其搜索页则正常退出。
   *   这是多产物拆分后的常规路径 —— dotSearch for Bing 不会去处理 Google 页面。
   * @param options.force 测试用：跳过 URL 归属校验。
   *   验证脚本把抓取下来的页面喂给浏览器时，地址栏是本地服务地址而非
   *   bing.com，isSearchPage 必然不成立，脚本会静默退出。
   */
  async start(
    options: { target?: EngineAdapter; force?: EngineAdapter } = {},
  ): Promise<void> {
    const engine =
      options.force ??
      options.target ??
      detectEngine(new URL(location.href));

    if (!engine) {
      log.warn('当前页面不属于任何已适配的搜索引擎，脚本不启动。');
      return;
    }

    const forced = Boolean(options.force);

    /*
     * 限定引擎时（常规路径），先确认当前页面确实由该引擎负责。
     *
     * 「负责」包括搜索结果页与设置页：脚本除了重写结果页，
     * 还会在设置页折叠已被取代的设置项。
     * 两者都不是就安静退出 —— @match 已经做过一层门禁，这里是第二道，
     * 防止通配规则意外命中（例如必应的 *.bing.com/search* 也会命中
     * 某些子域上的非搜索路径）。
     */
    const startUrl = new URL(location.href);
    if (
      !forced &&
      !engine.isSearchPage(startUrl) &&
      !engine.isSettingsPage?.(startUrl)
    ) {
      log.info(`当前页面不是 ${engine.name} 的搜索或设置页，脚本不启动。`);
      return;
    }

    if (engine.isAlreadyInjected(document)) {
      log.warn('脚本已在本页面运行过，跳过重复注入。');
      return;
    }
    engine.markInjected(document);

    /*
     * 启动全程用 try 包住，失败时**撤销注入标记**。
     *
     * 标记的作用是防 SPA 重复注入，但它一旦置位就再没有补救机会：
     * 启动若因任何原因中断，这个文档会被永久判定为「已注入」，
     * 后续重试（换词、验证脚本重注入）全部被挡回，
     * 用户看到的是「脚本完全没反应」而控制台只有一条启动报错。
     * 清掉标记后，至少下一次触发还能再试一遍。
     */
    try {
      this.engine = engine;
      injectStyle(css);
      this.cssInjected = true;

      this.disposers.push(
        onUrlChange((url) => {
          // 强制模式下引擎固定，不响应 URL 变化
          if (forced) return;

          /*
           * 限定引擎时（常规路径），URL 变化只在仍属于本引擎搜索页时处理；
           * 跳到别的站点就不要再动了 —— 那是另一个产物的职责。
           */
          if (options.target && !engine.isSearchPage(url)) return;

          const next = detectEngine(url);
          if (!next) return;
          if (next === this.engine) {
            void this.runAll(url);
          } else {
            log.info(`切换引擎：${this.engine?.name ?? '-'} → ${next.name}`);
            this.teardownFeatures();
            this.engine = next;
            void this.runAll(url);
          }
        }),
      );

      await this.runAll(new URL(location.href), forced);
      log.info(`${engine.name} 增强已启用，共 ${this.active.size} 个功能。`);
    } catch (err) {
      engine.unmarkInjected(document);
      this.engine = null;
      throw err;
    }
  }

  /** 跑一轮所有功能（首次加载与换词后共用） */
  private async runAll(url: URL, forced = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;

    /*
     * 页面归属校验。
     *
     * 早期只认「搜索结果页」，因为当时脚本只做重写。
     * 现在它还负责设置页（/account/general）上的设置项折叠，
     * 因此凡是引擎自己认领的页面都放行，具体某个功能该不该跑
     * 由它自己的 supports()/内部判断决定 ——
     * core 不替功能做这个决定。
     *
     * 强制模式下（测试）一律放行。
     */
    const belongs = engine.isSearchPage(url) || Boolean(engine.isSettingsPage?.(url));
    if (!forced && !belongs) return;

    /*
     * 页面已被重写（根容器存在）说明原站 DOM 不会再变化。
     *
     * 这里不能无条件重建，也不能无条件跳过：
     *   - 跳过：正常换词场景，原站不会再渲染新结果，重建只会得到空内容
     *   - 重建：Firefox 从 bfcache 恢复时，重写的 DOM 会被一并恢复，
     *           但原站分页可能已失效（曾出现重写后分页缺失）
     *
     * 判据：重建后的页面里若缺少分页导航，说明状态不完整，需要重来。
     * 判据本身交给 features 决定，core 只负责执行。
     *
     * ⚠️ 这条判据同时兜住一条隐蔽的路径：搜索隐私增强在重写结束后调用
     * history.replaceState 净化地址栏，而 onUrlChange 的补丁会把它当成
     * 一次导航、再触发一轮 runAll。此刻根容器与分页都已就位，
     * 于是被这里判为「状态完整」而跳过 —— 不会出现两份 se-root。
     * 因此 **replaceState 必须留在重写完成之后**，不能挪到构建阶段：
     * 那时根容器还没进文档，重入的 runAll 会真的再重写一遍。
     */
    if (document.getElementById('se-root')) {
      const state = ALL_FEATURES
        .filter((f) => f.id === 'strip-to-results')
        .map((f) => f.needsRebuild?.(engine))
        .find((v) => v !== undefined);

      if (state !== true) {
        log.warn('[换词检测] 已重写且状态完整 → 跳过');
        return;
      }
      log.warn('[换词检测] 状态不完整（如缺分页）→ 重建');
      // 移除旧根容器，让功能能重新解析原站 DOM
      document.getElementById('se-root')?.remove();
    }

    // 等结果容器出现再执行，避免在骨架屏阶段空跑
    const container = await waitForSelector(engine.resultContainerSelector, { timeout: 8_000 });
    if (!container) {
      log.warn(`未等到结果容器：${engine.resultContainerSelector}`);
      return;
    }

    const ctx: FeatureContext = { engine, query: engine.parseQuery(url) ?? '', url };

    for (const feature of ALL_FEATURES) {
      if (!this.matchesEngine(feature, engine)) continue;
      await this.runFeature(feature, ctx);
    }
  }

  /** 执行单个功能；返回 Promise 以便按顺序等待（顺序见 features/index.ts） */
  private async runFeature(feature: Feature, ctx?: FeatureContext): Promise<void> {
    if (ctx && !feature.supports(ctx.engine)) return;
    const context = ctx ?? { engine: this.engine!, query: '', url: new URL(location.href) };
    try {
      // 必须 await：顺序语义见 features/index.ts 的说明
      await feature.onNavigate(context);
      this.active.add(feature);
    } catch (err) {
      log.error(`功能 ${feature.id} 执行失败：`, err);
    }
  }

  private matchesEngine(feature: Feature, engine: EngineAdapter): boolean {
    return feature.engines === 'all' || feature.engines.includes(engine.id);
  }

  private teardownFeatures(): void {
    for (const feature of this.active) feature.dispose?.();
    this.active.clear();
  }

  stop(): void {
    this.teardownFeatures();
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    if (this.cssInjected) {
      document.getElementById('search-enhance-styles')?.remove();
      this.cssInjected = false;
    }
  }
}

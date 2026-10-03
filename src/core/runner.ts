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
   * 首次启动：匹配引擎、建立导航监听、执行功能
   *
   * @param forceEngine 测试用：跳过 URL 匹配，强制指定引擎。
   *   验证脚本需要把抓取下来的页面喂给浏览器，此时地址栏是本地服务地址而非
   *   bing.com，detectEngine 匹配不到，脚本会静默退出。
   */
  async start(forceEngine?: EngineAdapter): Promise<void> {
    const engine = forceEngine ?? detectEngine(new URL(location.href));
    if (!engine) {
      log.warn('当前页面不属于任何已适配的搜索引擎，脚本不启动。');
      return;
    }

    if (engine.isAlreadyInjected(document)) {
      log.warn('脚本已在本页面运行过，跳过重复注入。');
      return;
    }
    engine.markInjected(document);

    this.engine = engine;
    injectStyle(css);
    this.cssInjected = true;

    const forced = Boolean(forceEngine);

    this.disposers.push(
      onUrlChange((url) => {
        // 强制模式下引擎固定，不响应 URL 变化
        if (forced) return;
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
  }

  /** 跑一轮所有功能（首次加载与换词后共用） */
  private async runAll(url: URL, forced = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    // 强制模式下（测试）跳过页面归属校验
    if (!forced && !engine.isSearchPage(url)) return;

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

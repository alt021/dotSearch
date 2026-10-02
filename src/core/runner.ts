/**
 * 运行时调度
 *
 * 职责：识别当前引擎 → 在其搜索页上按开关依次执行已启用的功能。
 * 具体功能实现见 src/features/，引擎差异见 src/engines/。
 */
import type { Feature, FeatureContext } from '../types/feature.js';
import type { EngineAdapter } from '../types/engine.js';
import { SettingsStore, injectStyle, log, registerMenu } from './env.js';
import { onUrlChange, waitForSelector } from './dom.js';
import { detectEngine } from '../engines/index.js';
import { ALL_FEATURES } from '../features/index.js';
import css from '../styles/base.css';

const DEBUG_FLAG = '__searchEnhanceDebug__';

export class Runner {
  private readonly settings = new SettingsStore();
  private engine: EngineAdapter | null = null;
  private readonly active = new Set<Feature>();
  private readonly disposers: Array<() => void> = [];
  private cssInjected = false;

  /**
   * 首次启动：匹配引擎、建立导航监听、注册菜单
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
    this.registerMenus();

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

  private registerMenus(): void {
    registerMenu('🐛 切换调试日志', () => {
      const scope = globalThis as unknown as Record<string, boolean>;
      const next = !scope[DEBUG_FLAG];
      scope[DEBUG_FLAG] = next;
      log.setDebug(next);
      log.info(`调试日志：${next ? '开' : '关'}`);
    });

    for (const feature of ALL_FEATURES) {
      const on = this.settings.isEnabled(feature);
      registerMenu(`${on ? '☑' : '☐'} ${feature.name}`, () => {
        const nowOn = this.settings.toggle(feature);
        if (nowOn) {
          this.runFeature(feature);
        } else {
          feature.dispose?.();
          this.active.delete(feature);
        }
        log.info(`${feature.name}：${nowOn ? '已开启' : '已关闭'}（刷新后完全生效）`);
      });
    }
  }

  /** 跑一轮所有功能（首次加载与换词后共用） */
  private async runAll(url: URL, forced = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    // 强制模式下（测试）跳过页面归属校验
    if (!forced && !engine.isSearchPage(url)) return;

    // 页面已被重写（根容器存在）说明原站 DOM 不会再变化，
    // 此时换词不会再由 SPA 渲染出新的结果容器，跳过等待避免空耗
    if (document.getElementById('se-root')) return;

    // 等结果容器出现再执行，避免在骨架屏阶段空跑
    const container = await waitForSelector(engine.resultContainerSelector, { timeout: 8_000 });
    if (!container) {
      log.warn(`未等到结果容器：${engine.resultContainerSelector}`);
      return;
    }

    const ctx: FeatureContext = { engine, query: engine.parseQuery(url) ?? '', url };

    for (const feature of ALL_FEATURES) {
      if (!this.settings.isEnabled(feature)) continue;
      if (!this.matchesEngine(feature, engine)) continue;
      this.runFeature(feature, ctx);
    }
  }

  private runFeature(feature: Feature, ctx?: FeatureContext): void {
    if (ctx && !feature.supports(ctx.engine)) return;
    const context = ctx ?? { engine: this.engine!, query: '', url: new URL(location.href) };
    try {
      const result = feature.onNavigate(context);
      if (result instanceof Promise) {
        result.catch((err) => log.error(`功能 ${feature.id} 执行失败：`, err));
      }
      this.active.add(feature);
    } catch (err) {
      log.error(`功能 ${feature.id} 抛错：`, err);
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

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
import css from '../styles/main.css';

const DEBUG_FLAG = '__searchEnhanceDebug__';

export class Runner {
  private readonly settings = new SettingsStore();
  private engine: EngineAdapter | null = null;
  private readonly active = new Set<Feature>();
  private readonly disposers: Array<() => void> = [];
  private cssInjected = false;

  /** 首次启动：匹配引擎、建立导航监听、注册菜单 */
  async start(): Promise<void> {
    const engine = detectEngine(new URL(location.href));
    if (!engine) return;

    if (engine.isAlreadyInjected(document)) {
      log.warn('脚本已在本页面运行过，跳过重复注入。');
      return;
    }
    engine.markInjected(document);

    this.engine = engine;
    injectStyle(css);
    this.cssInjected = true;
    this.registerMenus();

    this.disposers.push(
      onUrlChange((url) => {
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

    await this.runAll(new URL(location.href));
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
  private async runAll(url: URL): Promise<void> {
    const engine = this.engine;
    if (!engine || !engine.isSearchPage(url)) return;

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

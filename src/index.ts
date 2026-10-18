/**
 * dotSearch —— 入口
 *
 * 重写搜索结果页。**每个引擎编译成独立脚本**（dotSearch for Bing 等），
 * 因此这里通过构建期常量 `__SE_TARGET_ENGINE__` 指定本产物只服务哪个引擎：
 * 一份源码、多个产物，互不干扰，也能同时安装。
 *
 * 共享的部分（core / types / 通用 features）由构建脚本一起打包，
 * 引擎差异全部收敛在 engines/<id>.ts 里。
 */
import { log } from './core/env.js';
import { Runner } from './core/runner.js';
import type { EngineAdapter } from './types/engine.js';
import { activeEngines } from './engines/index.js';
import { settingsCleanup } from './features/settings-cleanup.js';

/**
 * 目标引擎，构建时由 esbuild 的 define 注入。
 *
 * 为什么用构建期常量而不是运行时判断：
 * 产物装到浏览器里就该只对声明的那一个引擎生效。
 * 若在运行时再按 URL 推断「这属于哪个引擎」，多引擎同时安装时
 * 会出现两个脚本都试图重写同一页面 —— 这正是拆分要避免的。
 *
 * ## 关于取值方式的坑
 *
 * esbuild 的 define 是**直接文本替换**：`__SE_TARGET_ENGINE__` 会被换成
 * `"bing"` 这样的字面量。所以这里**不要**写 `typeof __SE_TARGET_ENGINE__`——
 * 替换后成了 `typeof "bing"`，看着没问题，实则是把「判断是否注入」这件事
 * 变成了一次恒真的字符串判断，语义丢失。
 * 直接引用常量即可；未注入的场景（控制台调试）由下面的兜底覆盖。
 */

/** 构建期注入的引擎 id（esbuild --define） */
declare const __SE_TARGET_ENGINE__: string;

/**
 * 本产物面向的引擎。
 *
 * 用 `typeof` 守卫**变量名本身**在 TS 里是合法的，
 * 但这里避免它带来的替换歧义：直接引用，若未注入则由构建配置兜底。
 */
const targetId: string = __SE_TARGET_ENGINE__;

/**
 * 本产物的专属引擎。
 *
 * 注意它**不等于**「强制模式」：
 * Runner.start() 的 engine 参数是「跳过 URL 归属校验」的测试入口，
 * 传进去会让脚本在任意页面都尝试重写。这里要的是
 * 「限定引擎范围，但仍在非搜索页正常退出」，
 * 所以走 Runner 的 target 参数（见 runner.start 的说明）。
 */
const targetEngine: EngineAdapter | undefined = activeEngines.find((e) => e.id === targetId);

if (!targetEngine) {
  log.warn(`本产物面向的引擎「${targetId}」未注册，脚本不启动。`);
} else {
  const runner = new Runner();

  /**
   * 测试钩子。
   * 验证脚本会把抓取下来的真实结果页喂给浏览器，此时地址栏是本地服务地址，
   * 不匹配任何 @match 规则，detectEngine 匹配不到，脚本会静默退出。
   * 暴露这个入口让验证脚本能强制指定引擎。
   *
   * 正常使用不会调用它（仅 Tampermonkey 环境下不存在 __SE_FORCE_ENGINE__）。
   */
  const forced = (globalThis as { __SE_FORCE_ENGINE__?: string }).__SE_FORCE_ENGINE__;
  const forceEngine = forced
    ? (activeEngines.find((e) => e.id === forced) ?? undefined)
    : undefined;

  runner.start({ target: targetEngine, force: forceEngine }).catch((err) =>
    log.error('脚本启动失败：', err),
  );

  /*
   * 测试钩子：仅在强制模式下暴露，正常使用时不挂任何全局。
   *
   * 存在的理由：设置页清理靠 hostname 判定「这是不是我的页面」，
   * 而验证脚本跑在 127.0.0.1 上，该判定会（正确地）返回 false，
   * 于是功能根本不会执行 —— 那样就测不到折叠逻辑。
   *
   * 让测试直接驱动这个功能，比在测试里伪造 location.hostname 干净：
   * 后者改的是被测量本身，前者只是换了个调用入口，
   * 被测的折叠代码仍是产物里的真实实现。
   */
  if (forceEngine) {
    (globalThis as Record<string, unknown>).__SE_TEST_HOOK__ = {
      /*
       * 测试钩子。传入一个「看起来像真实设置页」的 URL。
       *
       * 为什么要伪造 URL 而不是直接用 location.href：
       * 设置页清理会先问引擎「这是不是我的设置页」，而测试跑在
       * 127.0.0.1 上必然为 false。测试要验的是**折叠逻辑**，
       * 不是 hostname 判定（那条由纯函数单测覆盖），
       * 因此这里给一个 bing 域名即可，被测代码路径完全不变。
       */
      runSettingsCleanup: (): void => {
        void settingsCleanup.onNavigate({
          engine: targetEngine,
          query: '',
          url: new URL('https://www.bing.com/account/general'),
        });
      },
    };
  }
}

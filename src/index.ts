/**
 * dotSearch —— 入口
 *
 * 重写 Bing / Google / 百度 的搜索结果页。
 * 当前仅 Bing 已接入适配器，Google 与百度为预留扩展位。
 */
import { log } from './core/env.js';
import { Runner } from './core/runner.js';
import { activeEngines } from './engines/index.js';

const runner = new Runner();

/**
 * 测试钩子。
 * 验证脚本会把抓取下来的真实结果页喂给浏览器，此时地址栏是本地服务地址，
 * 不匹配任何 @match 规则，detectEngine 匹配不到，脚本会静默退出。
 * 暴露这个入口让 scripts/verify-strip.mjs 能强制指定引擎。
 *
 * 正常使用不会调用它（仅 Tampermonkey 环境下不存在 __SE_FORCE_ENGINE__）。
 */
const forced = (globalThis as { __SE_FORCE_ENGINE__?: string }).__SE_FORCE_ENGINE__;
const forceEngine = forced ? activeEngines.find((e) => e.id === forced) : undefined;

runner.start(forceEngine).catch((err) => log.error('脚本启动失败：', err));

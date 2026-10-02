/**
 * Search Enhance —— 入口
 *
 * UserScript 增强 Bing / Google / 百度 的搜索体验。
 * 当前仅 Bing 已接入适配器，Google 与百度为预留扩展位。
 */
import { log } from './core/env.js';
import { Runner } from './core/runner.js';

const runner = new Runner();

runner.start().catch((err) => log.error('脚本启动失败：', err));

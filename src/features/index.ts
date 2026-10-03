import type { Feature } from '../types/feature.js';
import { stripToResults } from './strip-to-results.js';
import { toolMenu } from './tool-menu.js';
import { pagetualBridge } from './pagetual-bridge.js';

/**
 * 功能注册表
 *
 * 项目定位是「重写搜索结果页」。
 * **顺序即执行顺序，且 Runner 会依次 await** ——
 * 这很关键：后两个功能都依赖 stripToResults 先把页面与隐藏数据源准备好。
 * 顺序即：重写页面 → 挂页头菜单 → 接上永页机协同。
 */
export const ALL_FEATURES: Feature[] = [stripToResults, toolMenu, pagetualBridge];

export { stripToResults, toolMenu, pagetualBridge };

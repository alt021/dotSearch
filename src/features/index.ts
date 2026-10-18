import type { Feature } from '../types/feature.js';
import { stripToResults } from './strip-to-results.js';
import { toolMenu } from './tool-menu.js';
import { pagetualBridge } from './pagetual-bridge.js';
import { settingsCleanup } from './settings-cleanup.js';

/**
 * 功能注册表
 *
 * 项目定位是「重写搜索结果页」。
 * **顺序即执行顺序，且 Runner 会依次 await** ——
 * 这很关键：后几个功能都依赖 stripToResults 先把页面与隐藏数据源准备好。
 * 顺序即：重写页面 → 挂页头菜单 → 接上永页机协同 → 清理设置页。
 *
 * settingsCleanup 排在最后不是随意的：它作用于**另一个页面**
 * （/account/general），与结果页重写互不相干。
 * 放在末尾可保证它绝不会先于重写抢跑，即便将来有人放宽
 * 各功能的 applies-to 范围。
 */
export const ALL_FEATURES: Feature[] = [
  stripToResults,
  toolMenu,
  pagetualBridge,
  settingsCleanup,
];

export { stripToResults, toolMenu, pagetualBridge, settingsCleanup };

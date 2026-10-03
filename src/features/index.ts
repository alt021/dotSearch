import type { Feature } from '../types/feature.js';
import { stripToResults } from './strip-to-results.js';
import { toolMenu } from './tool-menu.js';

/**
 * 功能注册表
 *
 * 项目定位是「重写搜索结果页」。
 * **顺序即执行顺序，且 Runner 会依次 await** ——
 * 这很关键：stripToResults 是异步的（要等分页渲染完），
 * 页头菜单必须等它重建完页头之后才能挂载。
 */
export const ALL_FEATURES: Feature[] = [stripToResults, toolMenu];

export { stripToResults, toolMenu };

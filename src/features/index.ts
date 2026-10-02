import type { Feature } from '../types/feature.js';
import { stripToResults } from './strip-to-results.js';

/**
 * 功能注册表
 *
 * 项目定位是「重写搜索结果页」，因此首个功能就是精简模式本身，
 * 后续的视觉重设计、交互增强等能力依次追加到这里。
 * 顺序即执行顺序。
 */
export const ALL_FEATURES: Feature[] = [stripToResults];

export { stripToResults };

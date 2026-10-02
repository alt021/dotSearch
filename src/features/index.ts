import type { Feature } from '../types/feature.js';
import { hideAds } from './hide-ads.js';
import { resultNavigation } from './result-navigation.js';

/**
 * 功能注册表
 * 新增功能：写好 Feature 实现后在这里登记即可。
 * 顺序即执行顺序。
 */
export const ALL_FEATURES: Feature[] = [hideAds, resultNavigation];

export { hideAds, resultNavigation };

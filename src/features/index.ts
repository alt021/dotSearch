import type { Feature } from '../types/feature.js';
import { stripToResults } from './strip-to-results.js';
import { toolSidebar } from './tool-sidebar.js';

/**
 * 功能注册表
 *
 * 项目定位是「重写搜索结果页」。
 * **顺序即执行顺序，且 Runner 会依次 await** ——
 * 这很关键：stripToResults 是异步的（要等分页渲染完），
 * 若让侧边栏先于它挂载，侧边栏会随后续的 body 清空一起被抹掉。
 */
export const ALL_FEATURES: Feature[] = [stripToResults, toolSidebar];

export { stripToResults, toolSidebar };

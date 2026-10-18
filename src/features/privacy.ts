/**
 * 链接净化
 *
 * 目标只有一个：**搜索页地址里不夹带追踪与识别参数**。
 *
 * ## 为什么用白名单而不是黑名单
 *
 * 黑名单（删掉已知的 cvid / IG / form …）看着更保守，实际上是错的：
 * 搜索引擎新增一个标识参数时，黑名单会**静默放行**它，
 * 而用户以为开了净化就干净了。
 * 白名单只保留「页面功能确实需要」的参数，新增参数默认被丢弃 ——
 * 失败方向是安全的（顶多丢掉一个不影响检索的过滤参数）。
 *
 * ## 能力边界（必须如实告知用户）
 *
 * 本功能**只处理地址栏**。它不改变：
 *   - Cookie：Bing 依然会下发与携带自己的 Cookie
 *   - 浏览器指纹：TLS / UA / Client Hints 由浏览器决定
 *   - 网络层标识：IP 地址
 *
 * 早期版本曾尝试清理 Cookie 实现会话隔离，真机验证效果不佳且
 * 依赖 `GM_cookie` 的平台细节（签名不一致、Bing 会重新下发），
 * 已整体移除。保留一个诚实的、看得见效果的功能，比留一个
 * 「说得很强、实际不可靠」的功能更好。
 */

/** 净化模式下 URL 里允许保留的参数（引擎自身的搜索词参数另行保留） */
const KEPT_PARAMS = new Set([
  // 分页：第 N 页 = first 偏移，重写后的分页导航完全依赖它
  'first',
  // 每页条数：若原地址指定了非默认值，丢掉会让页数与偏移的推算错位
  'count',
]);

/**
 * 净化一个搜索页地址：只保留搜索词与分页所需参数。
 *
 * @param url         原始地址
 * @param queryParam  该引擎的搜索词参数名（Bing 为 q，百度为 wd）
 * @returns 净化后的地址
 */
export function sanitizeSearchUrl(url: URL, queryParam: string): URL {
  const clean = new URL(url.href);
  const kept = new Map<string, string>();

  const query = clean.searchParams.get(queryParam);
  if (query !== null) kept.set(queryParam, query);

  for (const [key, value] of clean.searchParams) {
    if (KEPT_PARAMS.has(key)) kept.set(key, value);
  }

  // 先清空再按白名单回填，保留参数原始相对顺序（q 在前，便于阅读与复制）
  for (const key of [...clean.searchParams.keys()]) clean.searchParams.delete(key);
  for (const [key, value] of kept) clean.searchParams.set(key, value);

  // 徽标 / 锚点可能夹带追踪参数，一并去掉
  clean.hash = '';
  return clean;
}

/**
 * 把当前地址栏换成净化后的地址。
 *
 * 用 replaceState 而非 assign：不产生历史记录、不重新加载页面 ——
 * 我们只是把「刚才那次导航用过的地址」改写干净，
 * 页面内容（已经重写好的结果）必须原样保留。
 *
 * ⚠️ 时机很关键，见 strip-to-results 里的调用点说明：
 * 必须在**重写完成之后**调用，否则清理触发的 URL 变化通知
 * 会让 Runner 以为发生了换词、再跑一轮重写，出现两份根容器。
 *
 * @returns 是否真的改了地址
 */
export function cleanAddressBar(queryParam: string): boolean {
  const current = new URL(location.href);
  const clean = sanitizeSearchUrl(current, queryParam);
  if (clean.href === current.href) return false;
  try {
    history.replaceState(history.state, '', clean.href);
    return true;
  } catch {
    // 极少数情况下（沙箱 / 跨源 iframe）replaceState 会抛错，忽略即可
    return false;
  }
}

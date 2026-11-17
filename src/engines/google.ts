import type { EngineAdapter, MenuEntry, SearchResult } from '../types/engine.js';
import { text } from '../core/dom.js';

/*
 * Google 搜索前端。
 *
 * ## 地区域名
 *
 * Google 没有「一个 www.google.com 走天下」这回事：按国家/地区分到
 * google.de、google.co.jp、google.com.hk … 而且同一个国家也可能换后缀。
 * 因此这里用**后缀正则**而不是有限白名单 —— 白名单追不上 Google 的域名表，
 * 漏掉的结果是脚本静默退出、整个增强都不生效。
 *
 * 正则只接受 `google.<2-3 位>` 或 `google.<2-3 位>.<2 位>`，
 * 且主机名前面最多一个 `www.`：
 *   www.google.com / www.google.com.hk / www.google.co.jp / google.de  ✓
 *   images.google.com / news.google.com / www.google.evil.com            ✗
 *
 * ## 只接管网页搜索
 *
 * @match 里的 `/search*` 会连图片、视频、新闻一起命中，但它们的 DOM 与
 * 网页结果完全不同。这里在 isSearchPage 里排除 `tbm=` 与 `udm=` 的非网页
 * 垂直搜索，避免把图片页当网页结果重写。
 *
 * 结构基于 2025-2026 桌面版网页结果页：
 *   #search / #rso
 *     div.MjjYud                     每条结果的包裹层
 *       div.g                        自然结果本体（部分结果类型没有）
 *         div.yuRUbf > a > h3        标题链接
 *         cite                       展示用 URL
 *         div.VwiC3b                 摘要
 * 广告在 #tads / #tadsb / #bottomads / #tvcap 等容器里，
 * 自然结果里也可能混入 `.uEierd` / `[data-text-ad]`，提取时一并剔除。
 */

/** Google 地区域名判定（含 www. 与裸域） */
const GOOGLE_HOST_RE = /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;

function isGoogleHost(hostname: string): boolean {
  return GOOGLE_HOST_RE.test(hostname);
}

const INJECT_FLAG = '__searchEnhanceGoogle__';

const AD_SELECTOR =
  '#tads, #tadsb, #bottomads, #tvcap, .uEierd, [data-text-ad]';

export const google: EngineAdapter = {
  id: 'google',
  name: 'Google',
  theme: { accent: '#4285f4', accentDark: '#8ab4f8' },
  hostnames: [
    'www.google.com',
    'www.google.com.hk',
    'www.google.co.jp',
    'www.google.co.uk',
    'www.google.com.tw',
    'www.google.com.sg',
    'www.google.de',
    'www.google.fr',
  ],

  resultContainerSelector: '#search',
  resultItemSelector: '#rso div.g, #rso div.MjjYud',
  searchForm: { path: '/search', param: 'q' },

  pagination: {
    param: 'start',
    offsetBase: 0,
    defaultSize: 10,
    sizeChoices: [10, 20, 30, 50, 100],
    hintSelector: 'a[href*="start="], #botstuff a[href], #foot a[href]',
    pageContainers: ['#botstuff', '#foot', 'nav[aria-label]', 'nav[role="navigation"]'],
  },

  isSearchPage(url) {
    if (!isGoogleHost(url.hostname)) return false;

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/search') return false;

    /*
     * tbm 是 Google 的垂直搜索切换：
     * isch 图片、vid 视频、nws 新闻、shop 购物、bks 图书、lcl 本地 …
     * 它们的页面结构与网页结果完全不同，不在本脚本范围内。
     */
    if (url.searchParams.get('tbm')) return false;

    /*
     * udm 是新版的垂直/模式参数：14 是网页，2 是图片，7 是视频 …
     * 只接受缺省、0（全部）与 14（网页）。
     */
    const udm = url.searchParams.get('udm');
    if (udm && udm !== '0' && udm !== '14') return false;

    return true;
  },

  parseQuery(url) {
    return url.searchParams.get('q');
  },

  getAdSelectors() {
    return ['#tads', '#tadsb', '#bottomads', '#tvcap', '.uEierd', '[data-text-ad]'];
  },

  extractResults(root) {
    const scope = root.querySelector('#rso') ?? root;
    const nodes = collectResultNodes(scope);
    const results: SearchResult[] = [];

    for (const node of nodes) {
      const result = readResult(node, results.length);
      if (result) results.push(result);
    }

    return results;
  },

  isAlreadyInjected(doc) {
    return INJECT_FLAG in (doc as unknown as Record<string, unknown>);
  },

  markInjected(doc) {
    (doc as unknown as Record<string, unknown>)[INJECT_FLAG] = true;
  },

  unmarkInjected(doc) {
    delete (doc as unknown as Record<string, unknown>)[INJECT_FLAG];
  },

  /* ---------------- 菜单入口（Google 无账户条目） ---------------- */

  getExtraEntries(): MenuEntry[] {
    /*
     * 搜索设置跟着当前地区域名走：在 google.co.jp 上就留在 google.co.jp。
     * Google 的偏好页是 /preferences，带上当前界面的语言参数更贴近用户预期。
     */
    const target = new URL('/preferences', location.origin);
    const hl = new URL(location.href).searchParams.get('hl');
    if (hl) target.searchParams.set('hl', hl);

    return [{ label: '搜索设置', href: target.href }];
  },

  /*
   * 刻意不实现 captureSession / getSession / getAccountEntry：
   * Google 版不提供账号登录状态检测，菜单里也就没有账户条目。
   * 同样不实现 isSettingsPage / getSupersededSettings：
   * 本脚本不接管 Google 的偏好页，只提供入口。
   */
};

/** 收集结果节点：优先 `.g`，再补没有 `.g` 包裹但有标题链接的 MjjYud */
function collectResultNodes(scope: ParentNode): HTMLElement[] {
  const gs = uniqueTopLevel(
    Array.from(scope.querySelectorAll<HTMLElement>('div.g')),
  );
  if (gs.length > 0) {
    const extras = Array.from(scope.querySelectorAll<HTMLElement>('div.MjjYud')).filter(
      (node) =>
        !node.querySelector('div.g') &&
        node.querySelector('h3') !== null &&
        node.querySelector('a[href]') !== null,
    );
    return uniqueTopLevel([...gs, ...extras]);
  }

  return Array.from(scope.querySelectorAll<HTMLElement>('div.MjjYud')).filter(
    (node) => node.querySelector('h3') !== null && node.querySelector('a[href]') !== null,
  );
}

/** 去掉被另一个候选包含的节点，避免同一结果被提取两次 */
function uniqueTopLevel(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.filter(
    (node) => !nodes.some((other) => other !== node && other.contains(node)),
  );
}

/** 把单个候选节点读成结构化结果；不是自然结果则返回 null */
function readResult(node: HTMLElement, index: number): SearchResult | null {
  if (isAdNode(node)) return null;

  const heading = node.querySelector('h3');
  if (!heading) return null;

  const link =
    heading.closest<HTMLAnchorElement>('a[href]') ??
    node.querySelector<HTMLAnchorElement>('h3 a[href]') ??
    node.querySelector<HTMLAnchorElement>('a[href] h3')?.closest<HTMLAnchorElement>('a[href]') ??
    null;
  if (!link) return null;

  const rawHref = link.getAttribute('href') ?? '';
  if (rawHref === '' || /^(#|javascript:)/i.test(rawHref)) return null;

  let absolute: URL;
  try {
    absolute = new URL(rawHref, location.origin);
  } catch {
    return null;
  }

  const url = decodeGoogleRedirectUrl(absolute) ?? absolute.href;

  // Google 自己的「搜索」链接不是一条自然结果（例如「查看更多结果」）
  if (isGoogleSearchUrl(url)) return null;

  return {
    node,
    link,
    title: text(heading),
    snippet: text(node.querySelector('.VwiC3b, .lEBKkf, [data-sncf]')),
    displayUrl: formatDisplayUrl(url, text(node.querySelector('cite, .VuuXrf, .qzEoUe'))),
    url,
    index,
  };
}

/**
 * 来源行优先展示真实目标的完整 URL。
 *
 * Google 的 cite / VuuXrf 在不同版式下可能是站点名或只剩域名，
 * 直接照抄会看起来「缺一截」。目标地址本身已经有完整路径，
 * 这里只去掉查询串与 hash，避免把跟踪参数带进版面。
 *
 * 若跳转没能解码（目标仍是 google.com/url），回退到原站展示文本。
 */
function formatDisplayUrl(target: string, fallback: string): string {
  try {
    const url = new URL(target);
    if (isGoogleHost(url.hostname) && url.pathname === '/url') {
      return fallback || target;
    }
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return fallback || target;
  }
}

/** 广告 / 推广位：既看祖先容器，也看结果自身的标记与跳转域名 */
function isAdNode(node: HTMLElement): boolean {
  if (node.closest(AD_SELECTOR)) return true;
  if (node.querySelector('[data-text-ad], .uEierd')) return true;

  const link = node.querySelector<HTMLAnchorElement>('a[href]');
  if (!link) return false;

  try {
    const url = new URL(link.href, location.origin);
    if (url.pathname === '/aclk') return true;
    if (/(^|\.)googleadservices\.com$/i.test(url.hostname)) return true;
    if (/(^|\.)doubleclick\.net$/i.test(url.hostname)) return true;
  } catch {
    /* 解不出地址就不按广告处理，交给后续流程 */
  }
  return false;
}

/**
 * 解析 Google 的 `/url?q=<真实地址>` 跳转。
 * 解析失败返回 null，由调用方回退到原始 href。
 */
function decodeGoogleRedirectUrl(url: URL): string | null {
  if (!isGoogleHost(url.hostname)) return null;
  if (url.pathname !== '/url') return null;

  const raw = url.searchParams.get('q') ?? url.searchParams.get('url');
  if (!raw) return null;

  try {
    const target = new URL(raw);
    return /^https?:$/i.test(target.protocol) ? target.href : null;
  } catch {
    return null;
  }
}

/** 是否为 Google 自己的搜索页地址（不是自然结果目标） */
function isGoogleSearchUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return isGoogleHost(url.hostname) && url.pathname === '/search';
  } catch {
    return false;
  }
}

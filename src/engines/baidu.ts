import type { EngineAdapter, SearchResult } from '../types/engine.js';
import { text } from '../core/dom.js';

/**
 * 百度搜索前端。
 *
 * ## 结果结构（2025-2026 桌面版）
 *
 * `#content_left` 下混着两类同形节点：
 *   - `.result.c-container`        自然结果（本脚本只收这一类）
 *   - `.result-op.c-container`     百科、AI 直答、资讯等卡片，结构差异大
 *
 * 因此结果选择器只取 `.result`，不把 `.result-op` 的富卡片当成普通结果。
 * 自然结果的标题在 `h3 a`，摘要为 `.summary-text_*` / `.c-abstract`，
 * 来源展示在 `.cosc-source-text`；真实地址优先取节点上的 `mu` 属性，
 * 它通常已经是目标站地址，取不到时再回退到标题链接。
 *
 * ## 分页
 *
 * 百度用 `pn` 表示结果偏移量（0 起）：第 2 页 `pn=10`。
 * 所以 PaginationConfig 的 offsetBase 必须填 0，不能沿用 Bing 的 1。
 */
const BAIDU_HOSTS = ['www.baidu.com', 'baidu.com'] as const;

const INJECT_FLAG = '__searchEnhanceBaidu__';

const AD_SELECTORS = [
  '[data-tuiguang]',
  '[data-placeid]',
  '.ec_tuiguang',
  '.ec_adv',
  '.result-ad',
  '.bdbriwrapper-tuiguang',
] as const;

const AD_SELECTOR = AD_SELECTORS.join(', ');

function isBaiduHost(hostname: string): boolean {
  return hostname === 'www.baidu.com' || hostname === 'baidu.com';
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/i.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 优先从结果节点的 mu 属性取目标地址，回退到标题链接 */
function resolveTarget(node: HTMLElement, link: HTMLAnchorElement): string | null {
  const mu = node.getAttribute('mu')?.trim() ?? '';
  if (mu && isHttpUrl(mu)) {
    // nourl.ubs.baidu.com 是占位地址，不是真实目标
    if (!/^nourl\./i.test(new URL(mu).hostname)) return mu;
  }

  const raw = link.getAttribute('href')?.trim() ?? '';
  if (!raw || /^(#|javascript:)/i.test(raw)) return null;
  try {
    const absolute = new URL(raw, location.origin);
    return isHttpUrl(absolute.href) ? absolute.href : null;
  } catch {
    return null;
  }
}

/**
 * 来源行展示目标网站的完整链接。
 *
 * 百度新版结果只显示「CSDN博客」这类站名，旧版才给 c-showurl；
 * 但结果节点的 mu 属性里有真实目标地址。这里优先用目标 URL 的
 * 协议 + 主机 + 路径，站名只在无法解析目标（仍是百度跳转）时兜底。
 */
function resolveDisplayUrl(node: HTMLElement, target: string): string {
  const source = text(
    node.querySelector('[class*="source-text"], .c-showurl, .siteLink_9TPP3'),
  );

  try {
    const url = new URL(target);
    if (isBaiduHost(url.hostname) && (url.pathname === '/link' || url.pathname === '/baidu.php')) {
      return source || url.hostname;
    }
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return source;
  }
}

function isAdNode(node: HTMLElement): boolean {
  return node.matches(AD_SELECTOR) || node.closest(AD_SELECTOR) !== null;
}

/* ---------------- 首页：禁用首次搜索的 AJAX 热加载 ---------------- */

const SEARCH_INPUT_SELECTOR =
  '#chat-textarea, .chat-input-textarea, #kw, input[name="wd"], .s_ipt';
const SEARCH_SUBMIT_SELECTOR =
  '#chat-submit-button, #su, .s_btn, form#form input[type="submit"], form#form button[type="submit"]';

let homeSearchBound = false;
let homeNavigating = false;

function isBaiduHome(url: URL): boolean {
  if (!isBaiduHost(url.hostname)) return false;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return path === '/' || path === '/index.html';
}

function homeSearchInput(): HTMLInputElement | HTMLTextAreaElement | null {
  /*
   * 百度首页现有两套搜索框：虚拟表单里的隐藏 #kw，
   * 以及可见的 AI 搜索框 #chat-textarea。必须跳过不可见节点，
   * 否则会读到隐藏输入的空值而放弃拦截。
   */
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    SEARCH_INPUT_SELECTOR,
  );
  for (const input of inputs) {
    if (input.offsetWidth > 0 || input.offsetHeight > 0 || input.getClientRects().length > 0) {
      return input;
    }
  }
  return null;
}

/**
 * 跳到 /s 结果页。
 *
 * 返回 false 表示没有搜索词，此时不要拦截原事件 ——
 * 让百度自己处理空输入（通常只是聚焦输入框）。
 */
function goToSearchResults(): boolean {
  if (homeNavigating) return true;

  const keyword = homeSearchInput()?.value.trim() ?? '';
  if (!keyword) return false;

  homeNavigating = true;
  const target = new URL('/s', location.origin);
  target.searchParams.set('wd', keyword);
  location.assign(target.href);
  return true;
}

/** 拦下事件并整页跳转；顺序是「先导航，再阻止原处理器」 */
function interceptHomeSearch(event: Event): void {
  if (!goToSearchResults()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

/**
 * 在首页捕获搜索动作。
 *
 * 百度首页首次搜索走 AJAX：URL 变成 /s 但不刷新文档，脚本没有注入机会。
 * 这里在 document 的**捕获阶段**先于百度自己的处理器接住回车 / 提交 /
 * 按钮点击，改成 location.assign 的整页跳转；到 /s 后脚本正常接管。
 */
function bindHomeSearchBlock(): void {
  if (homeSearchBound) return;
  homeSearchBound = true;

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(SEARCH_INPUT_SELECTOR)) return;
      interceptHomeSearch(event);
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!form.querySelector(SEARCH_INPUT_SELECTOR)) return;
      interceptHomeSearch(event);
    },
    true,
  );

  const onSearchButton = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(SEARCH_SUBMIT_SELECTOR)) return;
    interceptHomeSearch(event);
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      onSearchButton(event);
    },
    true,
  );
  // 键盘触发按钮时没有 pointerdown，补 click
  document.addEventListener('click', onSearchButton, true);
}

export const baidu: EngineAdapter = {
  id: 'baidu',
  name: '百度',
  // 百度 Logo 的蓝色（#2529D8）；深色下提亮同色相保证对比度
  theme: { accent: '#2529d8', accentDark: '#7d83ff' },
  /*
   * 百度版菜单没有账户 / Rewards / 搜索设置等原站入口。
   * 保留的唯一功能是「附加设置」，因此菜单按钮直接打开该面板，
   * 不再先弹出一个只有一项的 popup。
   */
  directSettingsMenu: true,
  hostnames: BAIDU_HOSTS,

  resultContainerSelector: '#content_left',
  resultItemSelector: '#content_left .result',
  searchForm: { path: '/s', param: 'wd' },

  pagination: {
    param: 'pn',
    offsetBase: 0,
    defaultSize: 10,
    sizeChoices: [10, 20, 50],
    hintSelector: '#page a[href*="pn="], .page a[href*="pn="], a[href*="pn="]',
    pageContainers: ['#page', '.page'],
  },

  isSearchPage(url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return isBaiduHost(url.hostname) && path === '/s';
  },

  parseQuery(url) {
    return url.searchParams.get('wd') ?? url.searchParams.get('word');
  },

  getAdSelectors() {
    return [...AD_SELECTORS];
  },

  onHomePage(url) {
    if (!isBaiduHome(url)) return false;
    bindHomeSearchBlock();
    return true;
  },

  extractResults(root) {
    const scope = root.querySelector('#content_left') ?? root;
    const nodes = Array.from(scope.querySelectorAll<HTMLElement>('.result'));
    const results: SearchResult[] = [];

    for (const node of nodes) {
      if (isAdNode(node)) continue;

      const heading = node.querySelector('h3');
      const link =
        heading?.querySelector<HTMLAnchorElement>('a[href]') ??
        node.querySelector<HTMLAnchorElement>('h3 a[href]');
      if (!heading || !link) continue;

      const target = resolveTarget(node, link);
      if (!target) continue;

      results.push({
        node,
        link,
        title: text(heading),
        snippet: text(
          node.querySelector(
            '[class*="summary-text"], .c-abstract, [class*="content-right"], .c-span-last',
          ),
        ),
        displayUrl: resolveDisplayUrl(node, target),
        url: target,
        index: results.length,
      });
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

  /*
   * 刻意不实现账户、站内功能入口与设置页折叠：
   * 百度版只保留「附加设置」，其余原站菜单入口不提供。
   */
};

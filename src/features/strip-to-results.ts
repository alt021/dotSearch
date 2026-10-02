import type { Feature } from '../types/feature.js';
import type { EngineAdapter, SearchResult } from '../types/engine.js';
import { log } from '../core/env.js';

/**
 * 结果页重写：把 Bing 结果页替换为「搜索框 + 干净的结果列表」。
 *
 * 与「删掉多余元素、留下原站 DOM」的做法不同，这里**不复用任何原站结果节点**：
 * 先用 EngineAdapter 把结果解析成结构化数据，再从零构建 DOM。
 * 理由：
 *   - 原站节点的 class 与冗余包裹层在换掉 CSS 后毫无意义，只会污染后续样式
 *   - 重建后的 DOM 完全可控，视觉重设计不受原站结构束缚
 *   - 结果已结构化（标题/摘要/真实 URL/来源），后续做排序、过滤、去广告都很直接
 *
 * 副作用：原站搜索框随 #b_header 一起消失，其 pushState 换词机制随之失效。
 * 因此必须补一个搜索框，并用整页跳转（location.assign）提交，
 * 保证每次搜索都能重新触发本脚本。
 */

/** 需要保留的非结果内容 */
const EXTRA_SELECTORS = {
  /** 分页控件：仅取其页码链接用于重建 */
  pagination: '#b_pag',
  /** 顶部直答区：结构复杂，仅保留原节点 */
  answer: '#b_context .b_ans',
} as const;

/** 重建后的根容器 id，便于样式与后续功能定位 */
export const ROOT_ID = 'se-root';

export const stripToResults: Feature = {
  id: 'strip-to-results',
  name: '重写结果页',
  description: '移除顶栏、页脚、侧栏、广告与原站样式，用统一结构重建结果列表。',
  engines: 'all',
  defaultEnabled: true,

  supports() {
    return true;
  },

  onNavigate({ engine, query }) {
    // 已重写的页面跳过：清空 body 后原站不会再渲染
    if (document.getElementById(ROOT_ID)) {
      log.info('页面已重写，跳过重复执行');
      return;
    }

    const before = document.body.querySelectorAll('*').length;
    const container = document.querySelector(engine.resultContainerSelector);
    if (!container) {
      log.warn('结果容器未找到：', engine.resultContainerSelector);
      return;
    }

    // ---- 1. 解析结果为结构化数据（必须在清空 DOM 之前完成）---------------
    const results = engine.extractResults(container);
    const pages = extractPaginationLinks();
    // 直答区结构复杂，仅保留原节点
    const answerNode = document.querySelector(EXTRA_SELECTORS.answer);

    // ---- 2. 清空页面 -------------------------------------------------------
    document.body.innerHTML = '';
    document.body.className = 'se-stripped';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.className = 'se-root-html';

    // ---- 3. 重建结构 -------------------------------------------------------
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.query = query;

    root.appendChild(buildSearchBar(query, engine));

    const main = document.createElement('main');
    main.className = 'se-main';

    if (answerNode) {
      answerNode.classList.add('se-extra');
      main.appendChild(answerNode);
    }

    if (results.length > 0) {
      main.appendChild(buildResultList(results));
      if (pages.length > 0) main.appendChild(buildPagination(pages, query));
    } else {
      main.appendChild(buildEmptyState(query));
    }

    root.appendChild(main);
    document.body.appendChild(root);

    // 补上依赖动态状态的一小段规则；主体样式由 Runner 统一注入
    const style = document.createElement('style');
    style.id = 'se-rewrite-style';
    style.textContent = 'html.se-root-html { height: auto; }';
    document.head.appendChild(style);

    const after = document.body.querySelectorAll('*').length;
    log.info(
      `重写完成：DOM ${before} → ${after} 个节点，结果 ${results.length} 条` +
        `（${engine.name}，查询「${query}」）`,
    );
  },
};

/** 构建结果列表 */
function buildResultList(results: SearchResult[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'se-list';

  for (const result of results) {
    const item = document.createElement('li');
    item.className = 'se-item';

    // 标题
    const heading = document.createElement('h2');
    heading.className = 'se-title';
    const anchor = document.createElement('a');
    anchor.className = 'se-link';
    anchor.textContent = result.title || result.displayUrl || '(无标题)';
    // 优先用解析出的真实地址，失败则回退引擎跳转链接
    anchor.href = result.url ?? result.link?.href ?? '#';
    if (result.url) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
    heading.appendChild(anchor);
    item.appendChild(heading);

    // 来源 URL
    if (result.displayUrl) {
      const cite = document.createElement('cite');
      cite.className = 'se-cite';
      cite.textContent = result.displayUrl;
      item.appendChild(cite);
    }

    // 摘要
    if (result.snippet) {
      const desc = document.createElement('p');
      desc.className = 'se-snippet';
      desc.textContent = result.snippet;
      item.appendChild(desc);
    }

    list.appendChild(item);
  }

  return list;
}

/** 从原站分页控件提取页码链接，用于重建 */
function extractPaginationLinks(): Array<{ label: string; href: string }> {
  const root = document.querySelector(EXTRA_SELECTORS.pagination);
  if (!root) return [];

  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((a) => ({ label: (a.textContent ?? '').trim(), href: a.href }))
    .filter((x) => x.label.length > 0);
}

/** 构建分页导航 */
function buildPagination(
  pages: Array<{ label: string; href: string }>,
  query: string,
): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'se-pagination';
  nav.setAttribute('aria-label', '分页');

  for (const page of pages) {
    const link = document.createElement('a');
    link.className = 'se-page';
    link.href = page.href;
    link.textContent = page.label;
    // 引擎的跳转链接已带原始查询词，这里补上当前查询词保证一致
    if (query && !link.href.includes('q=')) {
      link.href += (link.href.includes('?') ? '&' : '?') + `q=${encodeURIComponent(query)}`;
    }
    nav.appendChild(link);
  }

  return nav;
}

/**
 * 构建搜索框。
 * 用 location.assign 走整页跳转，保证下次搜索时脚本能重新初始化
 * （原站 pushState 换词机制已随 #b_header 移除而失效）。
 */
function buildSearchBar(query: string, engine: EngineAdapter): HTMLElement {
  const form = document.createElement('form');
  form.className = 'se-search';
  form.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'se-search-input';
  input.value = query;
  input.placeholder = '搜索…';
  input.setAttribute('aria-label', '搜索');
  input.autofocus = true;

  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'se-search-btn';
  button.textContent = '搜索';

  form.append(input, button);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword) return;
    const { path, param } = engine.searchForm;
    window.location.assign(
      `${window.location.origin}${path}?${param}=${encodeURIComponent(keyword)}`,
    );
  });

  return form;
}

/** 无结果时的占位提示 */
function buildEmptyState(query: string): HTMLElement {
  const empty = document.createElement('p');
  empty.className = 'se-empty';
  empty.textContent = `没有找到与「${query}」相关的结果。`;
  return empty;
}

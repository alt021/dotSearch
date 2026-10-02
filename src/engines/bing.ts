import type { EngineAdapter } from '../types/engine.js';
import { text } from '../core/dom.js';

const HOSTS = ['www.bing.com', 'cn.bing.com', 'bing.com'];
const INJECT_FLAG = '__searchEnhanceBing__';

/**
 * Bing 适配器
 *
 * DOM 结构基于 2026 年 Bing 桌面版结果页：
 *   #b_results            结果容器
 *   li.b_algo             单条自然结果
 *   h2 a                  标题链接
 *   .b_caption p          摘要
 *   li.b_ad / .b_adSlug   广告与推广标记
 *
 * 注意：Bing 改版频繁。选择器失效时优先只改这里，
 * 不要把引擎专属选择器散落到 features/ 中。
 */
export const bing: EngineAdapter = {
  id: 'bing',
  name: 'Bing',
  hostnames: HOSTS,

  resultContainerSelector: '#b_results',
  resultItemSelector: 'li.b_algo',

  isSearchPage(url) {
    return HOSTS.includes(url.hostname) && url.pathname === '/search';
  },

  parseQuery(url) {
    return url.searchParams.get('q');
  },

  getAdSelectors() {
    return ['li.b_ad', 'li.b_adTop', '.b_adSlug', '.b_adBottom'];
  },

  extractResults(root) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('li.b_algo'));
    return nodes.map((node, index) => {
      const link = node.querySelector<HTMLAnchorElement>('h2 a[href]');
      const snippetEl = node.querySelector('.b_caption p, .b_lineclamp2, .b_algoSlug');

      return {
        node,
        link,
        title: text(node.querySelector('h2')),
        snippet: text(snippetEl),
        index,
      };
    });
  },

  isAlreadyInjected(doc) {
    return INJECT_FLAG in (doc as unknown as Record<string, unknown>);
  },

  markInjected(doc) {
    (doc as unknown as Record<string, unknown>)[INJECT_FLAG] = true;
  },
};

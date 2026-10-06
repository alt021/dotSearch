import type { EngineAdapter } from '../types/engine.js';
import { text } from '../core/dom.js';

/**
 * 百度适配器（预留扩展位，尚未接入调度）
 *
 * 百度结果 DOM 变动频繁且区分桌面/移动版，
 * 接入前需要先在真实结果页实测确定 #content_left 下的结果与广告选择器。
 */
export const baidu: EngineAdapter = {
  id: 'baidu',
  name: '百度',
  hostnames: ['www.baidu.com'],

  resultContainerSelector: '#content_left',
  resultItemSelector: '#content_left .result, #content_left .c-container',
  searchForm: { path: '/s', param: 'wd' },

  isSearchPage(url) {
    return url.hostname === 'www.baidu.com' && (url.pathname === '/s' || url.pathname === '/baidu');
  },

  parseQuery(url) {
    return url.searchParams.get('wd') ?? url.searchParams.get('word');
  },

  getAdSelectors() {
    return ['.ec_tuiguang', '.ec_adv', '.result-ad', '[data-placeid]'];
  },

  extractResults(root) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('#content_left .result'));
    return nodes.map((node, index) => {
      const link = node.querySelector<HTMLAnchorElement>('h3 a[href]');
      return {
        node,
        link,
        title: text(node.querySelector('h3')),
        snippet: text(node.querySelector('.c-abstract, .content-right_2s-H4')),
        displayUrl: text(node.querySelector('.c-showurl, .siteLink_9TPP3')),
        url: link?.href ?? null,
        index,
      };
    });
  },

  isAlreadyInjected() {
    return false;
  },

  markInjected() {
    /* TODO：接入时补上文档级标记 */
  },

  unmarkInjected() {
    /* TODO：与 markInjected 一同补上 */
  },
};

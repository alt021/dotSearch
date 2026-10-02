import type { EngineAdapter } from '../types/engine.js';
import { text } from '../core/dom.js';

/**
 * Google 适配器（预留扩展位，尚未接入调度）
 *
 * @match 规则暂时保留在 src/meta.ts 的 MATCHES_FUTURE 中。
 * 接入方式：engines/index.ts 里 enabled 改 true，并把 MATCHES_FUTURE
 * 中的规则移入 MATCHES_ACTIVE。
 */
export const google: EngineAdapter = {
  id: 'google',
  name: 'Google',
  hostnames: ['www.google.com', 'www.google.com.hk'],

  resultContainerSelector: '#search',
  resultItemSelector: '#search .g, #rso > div.g',

  isSearchPage(url) {
    return this.hostnames.includes(url.hostname) && url.pathname === '/search';
  },

  parseQuery(url) {
    return url.searchParams.get('q');
  },

  getAdSelectors() {
    return ['#tads', '#tadsb', '.commercial-unit-desktop-top', '#bottomads'];
  },

  extractResults(root) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('li.g, div.g'));
    return nodes.map((node, index) => {
      const link = node.querySelector<HTMLAnchorElement>('a[href^="http"]');
      return {
        node,
        link,
        title: text(node.querySelector('h3')),
        snippet: text(node.querySelector('.VwiC3b, [data-sncf]')),
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
};

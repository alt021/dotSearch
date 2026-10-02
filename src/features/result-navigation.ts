import type { Feature } from '../types/feature.js';
import { markOnce } from '../core/dom.js';
import { log, openInNewTab } from '../core/env.js';

/**
 * 交互增强：
 *  1. 结果链接改为新标签页打开（保留搜索结果页，方便回看）
 *  2. j / k 在结果间移动焦点，Enter 打开当前项
 */
export const resultNavigation: Feature = {
  id: 'result-navigation',
  name: '结果键盘导航',
  description: '结果链接在新标签打开；用 j / k 在结果间移动，Enter 打开当前项。',
  engines: 'all',
  defaultEnabled: true,

  supports() {
    return true;
  },

  onNavigate({ engine }) {
    const container = document.querySelector(engine.resultContainerSelector);
    if (!container) {
      log.warn('结果容器未找到，跳过键盘导航：', engine.resultContainerSelector);
      return;
    }

    const results = engine.extractResults(container);
    if (results.length === 0) return;

    // 1. 链接改为新标签打开（每条结果只处理一次）
    let patched = 0;
    for (const result of results) {
      const link = result.link;
      if (!link || !markOnce(link, 'newtab')) continue;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      patched += 1;
    }

    // 2. 绑定 j / k 导航。整个文档只绑一次，避免换词后重复监听
    if (markOnce(document.documentElement, 'resultnav')) {
      let cursor = -1;

      const currentResults = () =>
        engine.extractResults(document.querySelector(engine.resultContainerSelector) ?? document);

      const focusAt = (next: number) => {
        const items = currentResults();
        if (items.length === 0) return;
        cursor = (next + items.length) % items.length;
        items.forEach((item, i) => item.node.classList.toggle('se-cursor', i === cursor));
        items[cursor]?.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        log.info(`焦点移动到第 ${cursor + 1} 条`);
      };

      document.addEventListener(
        'keydown',
        (event) => {
          const el = event.target as HTMLElement | null;
          const typing =
            el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
          if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

          if (event.key === 'j' || event.key === 'J') {
            event.preventDefault();
            focusAt(cursor + 1);
          } else if (event.key === 'k' || event.key === 'K') {
            event.preventDefault();
            focusAt(cursor - 1);
          } else if (event.key === 'Enter' && cursor >= 0) {
            const href = currentResults()[cursor]?.link?.href;
            if (href) {
              event.preventDefault();
              openInNewTab(href, true);
            }
          }
        },
        true,
      );
    }

    log.info(`结果增强：新标签链接 ${patched} 条，共 ${results.length} 条结果`);
  },
};

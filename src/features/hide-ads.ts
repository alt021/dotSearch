import type { Feature } from '../types/feature.js';
import { log } from '../core/env.js';

/** 折叠 / 隐藏 Bing 搜索结果中的广告位 */
export const hideAds: Feature = {
  id: 'hide-ads',
  name: '隐藏广告位',
  description: '折叠 Bing 结果页中的广告与推广模块，减少视觉干扰。',
  engines: 'all',
  defaultEnabled: true,

  supports(engine) {
    return engine.getAdSelectors().length > 0;
  },

  onNavigate({ engine }) {
    const selectors = engine.getAdSelectors();
    let hidden = 0;

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const node = el as HTMLElement;
        if (node.dataset.seHidden === '1') return;
        node.dataset.seHidden = '1';
        node.classList.add('se-hidden');
        hidden += 1;
      });
    }

    // 广告被隐藏后布局会留白，交给 CSS 处理，这里只统计数据
    log.info(`隐藏广告元素：${hidden} 个`);
  },
};

import type { EngineAdapter } from '../types/engine.js';
import { text } from '../core/dom.js';

/*
 * 必应的搜索前端。
 *
 * 必应有多个**等价**入口：www / cn / www2 / www4 …
 * 并且它按 IP 分流 —— 同一个域名在不同网络下给出中国版或全球版，
 * 备用子域本身也随可用性增删。
 *
 * 所以这里用**后缀判定**而不是白名单：
 * 白名单天生追不上必应增删别名，www4 就是这么漏掉的
 * （漏掉的后果不是「功能降级」，而是脚本静默退出、整个增强都不生效）。
 *
 * 实测（2026-10，桌面版）：
 *   www2 / www4        可直接作为搜索入口，DOM 与 www 一致
 *   www3 / www5 / www6 302 回 cn.bing.com 首页，构不成入口
 *   m / global         跳回 cn.bing.com/search
 *
 * 理论上的例外是移动站（`m.` 前缀）：那套 DOM 完全不同。
 * 但即使误判也没有破坏性 —— 找不到结果容器时重写会直接退出，
 * 不触碰页面（见 strip-to-results 里的容器判空）。
 */
function isBingHost(hostname: string): boolean {
  return hostname === 'bing.com' || hostname.endsWith('.bing.com');
}

const INJECT_FLAG = '__searchEnhanceBing__';

/**
 * Bing 适配器
 *
 * 以下结构基于 2026-10 抓取的真实结果页校准（zh-CN 桌面版）：
 *   li.b_algo                        单条自然结果
 *     a.tilk                         头部可点区（内含站点图标与显示 URL）
 *       div.b_tpcn                   站点图标
 *       div.tpmeta > div.b_attribution > cite   显示的 URL 文本
 *     h2 > a > strong                标题（真正的链接）
 *     div.b_caption > p.b_lineclamp2 摘要
 *
 * 注意：Bing 改版频繁。选择器失效时优先只改这里，
 * 不要把引擎专属选择器散落到 features/ 中。
 *
 * 关于跳转链接：Bing 的 href 均为 `bing.com/ck/a?...` 形式的跳转地址，
 * 真实目标地址在 `u=` 查询参数里（base64 + 补位字符），
 * 解析方式见 decodeBingRedirectUrl。
 */
export const bing: EngineAdapter = {
  id: 'bing',
  name: 'Bing',
  /*
   * 仅供日志与调试查看，**不求穷举** ——
   * 识别一律走 isBingHost 的后缀判定，新增备用子域不必改这里。
   */
  hostnames: ['www.bing.com', 'cn.bing.com', 'www2.bing.com', 'www4.bing.com', 'bing.com'],

  resultContainerSelector: '#b_results',
  resultItemSelector: 'li.b_algo',
  searchForm: { path: '/search', param: 'q' },

  isSearchPage(url) {
    return isBingHost(url.hostname) && url.pathname === '/search';
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
      // 标题链接在 h2 内；a.tilk 是头部整体可点区，仅作兜底
      const titleLink = node.querySelector<HTMLAnchorElement>('h2 a[href]');
      const clickable = node.querySelector<HTMLAnchorElement>('a.tilk[href]');
      const rawHref = (titleLink ?? clickable)?.href ?? null;

      return {
        node,
        link: titleLink ?? clickable,
        title: text(node.querySelector('h2')),
        snippet: text(node.querySelector('.b_caption p, p.b_lineclamp2, .b_lineclamp2')),
        // cite 里是 Bing 展示用的可读 URL，比跳转链接更适合作为来源显示
        displayUrl: text(node.querySelector('div.b_attribution cite, cite')),
        // 解析出真实目标地址，供后续跳转/去广告逻辑使用
        url: rawHref ? decodeBingRedirectUrl(rawHref) ?? rawHref : null,
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

  unmarkInjected(doc) {
    delete (doc as unknown as Record<string, unknown>)[INJECT_FLAG];
  },
};

/**
 * 解析 Bing 跳转链接 `bing.com/ck/a?...&u=a1<base64url>`，
 * 取出真实目标地址。解析失败时返回 null，由调用方回退到原始 href。
 */
function decodeBingRedirectUrl(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.bing.com');
    const raw = url.searchParams.get('u');
    if (!raw) return null;

    // Bing 用 'a1' 作为 base64url 的前缀标记
    const b64 = raw.startsWith('a1') ? raw.slice(2) : raw;
    // base64url → base64：补齐 padding 并还原 URL 安全字符
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(padded);
    // 解出的是 UTF-8 字节，需按 UTF-8 还原为字符串
    const text = new TextDecoder('utf-8').decode(
      Uint8Array.from(decoded, (ch) => ch.charCodeAt(0)),
    );
    return /^https?:\/\//i.test(text) ? text : null;
  } catch {
    return null;
  }
}

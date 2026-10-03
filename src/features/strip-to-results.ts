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
  /**
   * 分页控件。
   *
   * 注意是 **class** 而非 id —— 实测 Bing 渲染为
   * `<li class="b_pag"><nav><ul class="sb_pagF"><li><a>…</a></li></ul></nav></li>`，
   * 不存在 id="b_pag"。用 #b_pag 永远匹配不到。
   *
   * 该 <li> 内首个子元素是 <link rel="stylesheet">，且其所在 <ol> 存在
   * 提前闭合（</ol></main>）——这类非标准嵌套在 Chromium 与 Firefox 中
   * 解析结果不同，因此**不能用后代选择器**（如 .b_pag .sb_pagF a），
   * 必须先用 querySelectorAll('.b_pag') 定位容器、再各自查询内部，
   * 避免跨浏览器的结构差异导致匹配失败。
   */
  pagination: '.b_pag',
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

    // 直答区是唯一会保留到新页面的原站节点，
    // 其内部常混入备案号、隐私政策、条款等合规链接，需先剔除
    if (answerNode) stripComplianceLinks(answerNode as HTMLElement);

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

    // 页头：瑞士风格以「元信息块 + 粗规则线」建立页面起点。
    // 页头内的大标题同时承担搜索输入职责，不再另设搜索框。
    root.appendChild(buildMasthead(query, results.length, engine));

    const main = document.createElement('main');
    main.className = 'se-main';

    if (answerNode) {
      answerNode.classList.add('se-extra');
      main.appendChild(answerNode);
    }

    if (results.length > 0) {
      main.appendChild(buildResultList(results));
      if (pages.length > 0) {
        main.appendChild(buildPagination(pages));
      } else {
        // 分页缺失是最常见的跨浏览器问题，此处显式告警而非静默跳过
        log.warn(
          '[分页缺失] 未提取到分页。容器探测：' +
            `.b_pag=${document.querySelectorAll('.b_pag').length} ` +
            `.sb_pagF=${document.querySelectorAll('.sb_pagF').length} ` +
            `a[aria-label^="第"]=${document.querySelectorAll('a[aria-label^="第"]').length}`,
        );
      }
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
    // 用 warn 级别输出关键诊断：Firefox 默认会显示 console.warn，
    // 而 console.info 需开启调试等级才可见，跨浏览器排查时容易看不到。
    log.warn(
      `[重写完成] DOM ${before} → ${after}，结果 ${results.length} 条，` +
        `分页 ${pages.length} 项（${engine.name}，查询「${query}」）`,
    );
  },
};

/**
 * 构建页头。
 *
 * 瑞士风格典型的杂志式页头：刊名式标识 + 查询词 + 统计信息，
 * 底部以粗规则线收束，替代任何色块或阴影装饰。
 *
 * 查询词本身即是搜索输入：点击即可编辑，按 Enter 发起搜索。
 * 因此页头不再另设独立搜索框，避免同一页面出现两个搜索入口。
 */
function buildMasthead(query: string, count: number, engine: EngineAdapter): HTMLElement {
  const head = document.createElement('header');
  head.className = 'se-masthead';

  const brand = document.createElement('p');
  brand.className = 'se-brand';
  // 用强调色方块作为唯一点缀，呼应瑞士国旗
  const mark = document.createElement('span');
  mark.className = 'se-mark';
  mark.setAttribute('aria-hidden', 'true');
  brand.append(mark, document.createTextNode(`${engine.name} — 检索`));
  head.appendChild(brand);

  // 查询词作为可编辑输入：大字号标题样式，回车即搜索
  const form = document.createElement('form');
  form.className = 'se-query-form';
  form.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'se-query';
  input.value = query;
  input.setAttribute('aria-label', '搜索关键词');
  input.spellcheck = false;
  input.autocomplete = 'off';
  // 点击页面其他区域时会失焦，避免残留的原生选中高亮影响观感
  input.addEventListener('blur', () => input.setSelectionRange(0, 0));

  const stat = document.createElement('p');
  stat.className = 'se-stat';
  // 默认显示结果数；进入编辑态后改为提示回车提交
  stat.textContent = `找到 ${count} 条结果`;

  form.append(input, stat);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword || keyword === query) return;
    const { path, param } = engine.searchForm;
    window.location.assign(
      `${window.location.origin}${path}?${param}=${encodeURIComponent(keyword)}`,
    );
  });

  // 聚焦时切换提示文案，让用户知道回车可用
  input.addEventListener('focus', () => {
    stat.textContent = '按回车键发起搜索';
  });

  // 失焦立即还原：舍弃用户对该标题的全部改动
  input.addEventListener('blur', () => {
    input.value = query;
    stat.textContent = `找到 ${count} 条结果`;
  });

  head.appendChild(form);
  return head;
}

/** 构建结果列表 */
function buildResultList(results: SearchResult[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'se-list';

  results.forEach((result, i) => {
    const item = document.createElement('li');
    item.className = 'se-item';

    // 左栏：序号。瑞士风格用等宽数字建立纵向韵律，替代装饰性图形
    const num = document.createElement('span');
    num.className = 'se-num';
    num.textContent = String(i + 1).padStart(2, '0');

    // 右栏：内容
    const body = document.createElement('div');
    body.className = 'se-body';

    // 来源：置于标题之上，用等宽小字，是瑞士风格典型的元信息前置手法
    if (result.displayUrl) {
      const cite = document.createElement('cite');
      cite.className = 'se-cite';
      cite.textContent = result.displayUrl;
      body.appendChild(cite);
    }

    const heading = document.createElement('h2');
    heading.className = 'se-title';
    const anchor = document.createElement('a');
    anchor.className = 'se-link';
    anchor.textContent = result.title || result.displayUrl || '(无标题)';
    heading.appendChild(anchor);
    body.appendChild(heading);

    if (result.snippet) {
      const desc = document.createElement('p');
      desc.className = 'se-snippet';
      desc.textContent = result.snippet;
      body.appendChild(desc);
    }

    // 整条可点击：用一个覆盖整栏的「stretched link」透明锚点。
    // 相比给整块包 <a>，这种方式保留了标题内独立的语义化链接
    // （利于中键新标签、复制链接、右键菜单），且不影响内部文本选择。
    const href = result.url ?? result.link?.href;
    if (href) {
      const hit = document.createElement('a');
      hit.className = 'se-hit';
      hit.href = href;
      hit.setAttribute('aria-hidden', 'true');
      hit.tabIndex = -1;
      item.append(num, hit, body);
    } else {
      item.append(num, body);
    }

    list.appendChild(item);
  });

  return list;
}

/** 一页分页项 */
interface PageLink {
  /** 显示文本 */
  label: string;
  /** 目标地址；当前页为 null */
  href: string | null;
  /** 完整的无障碍标签（如「第 2 页」「下一页」） */
  ariaLabel: string;
  /** 是否为当前所在页 */
  current: boolean;
}

/**
 * 从原站分页控件提取页码。
 *
 * 真实结构（实测）：
 *   li.b_pag > nav > ul.sb_pagF > li > a[aria-label="第 N 页"]
 *
 * 三个要点：
 *   - 当前页的 <a> **没有 href**（只有 .sb_pagS 标记），不能按 a[href] 过滤，否则当前页会丢失
 *   - 无障碍标签在 aria-label 上，文本可能被截断或为图标（下一页是 div.sw_next）
 *   - **分页容器在 Chromium 与 Firefox 中的 DOM 结构不同**（非标准嵌套：
 *     <li> 内含 <link>、所在 <ol> 提前闭合），后代选择器在 Firefox 上会失配。
 *     故先定位容器、再在容器内做多策略查询，任一命中即可。
 */
function extractPaginationLinks(): PageLink[] {
  // 策略 1：.b_pag 容器（正常路径）
  let containers = Array.from(document.querySelectorAll(EXTRA_SELECTORS.pagination));

  // 策略 2：容器找不到时，按页码特征全局兜底
  // （某些解析路径下 .b_pag 可能未生成出可查询的子树）
  if (containers.length === 0) {
    containers = [];
    const firstPageLink = document.querySelector('a[aria-label^="第"][aria-label$="页"]');
    containers = firstPageLink
      ? [firstPageLink.closest('nav, .b_pag, ul, div') ?? firstPageLink]
      : [];
  }

  if (containers.length === 0) return [];

  const pages: PageLink[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    // 容器内收集所有候选链接，兼容不同嵌套
    const anchors = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[aria-label], a[href], .sb_pag'),
    );
    if (anchors.length === 0) {
      // 容器自身可能就是链接（极端情况）
      if (container instanceof HTMLAnchorElement) anchors.push(container);
      else continue;
    }

    for (const a of anchors) {
      const ariaLabel = (a.getAttribute('aria-label') ?? '').trim();
      const rawHref = a.getAttribute('href');
      const isCurrent =
        !rawHref || a.classList.contains('sb_pagS') || ariaLabel.includes('当前');

      // 文本：图标型按钮（下一页/上一页）内部是 div.sw_next，需用 aria-label 兜底
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      const label = text || ariaLabel;
      if (!label) continue;

      // 只保留页码与翻页控件，过滤掉分页容器内的其他链接（如反馈按钮）
      const isPageLink =
        /^\d+$/.test(label) ||
        /^(上一页|下一页|上一页|上页|下页|Next|Previous|›|‹|>|»|<)/i.test(label) ||
        /^第\s*\d+\s*页$/.test(ariaLabel);
      if (!isPageLink) continue;

      // 去重：同一页可能同时有 aria-label 与文本命中
      const key = ariaLabel || label;
      if (seen.has(key)) continue;
      seen.add(key);

      pages.push({
        label,
        // 相对地址补全为绝对地址；当前页无 href
        href: rawHref ? safeAbsoluteUrl(rawHref) : null,
        ariaLabel: ariaLabel || label,
        current: isCurrent,
      });
    }
  }

  return pages;
}

/** 相对地址转绝对；解析失败时返回原值，避免整个流程崩掉 */
function safeAbsoluteUrl(href: string): string {
  try {
    return new URL(href, location.origin).href;
  } catch {
    return href;
  }
}

/** 构建分页导航 */
function buildPagination(pages: PageLink[]): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'se-pagination';
  nav.setAttribute('aria-label', '分页');

  for (const page of pages) {
    if (page.current) {
      // 当前页用 <span>，保持语义正确（不可点击的当前页不应是链接）
      const cur = document.createElement('span');
      cur.className = 'se-page se-page-current';
      cur.textContent = page.label;
      cur.setAttribute('aria-current', 'page');
      cur.setAttribute('aria-label', page.ariaLabel);
      nav.appendChild(cur);
      continue;
    }

    const link = document.createElement('a');
    link.className = 'se-page';
    link.href = page.href ?? '#';
    link.textContent = page.label;
    link.setAttribute('aria-label', page.ariaLabel);
    nav.appendChild(link);
  }

  return nav;
}


/** 无结果时的占位提示 */
function buildEmptyState(query: string): HTMLElement {
  const empty = document.createElement('p');
  empty.className = 'se-empty';
  empty.textContent = `没有找到与「${query}」相关的结果。`;
  return empty;
}

/** 判定链接文案是否属于备案 / 隐私 / 条款等合规信息 */
const COMPLIANCE_PATTERN =
  /隐私|条款|条款|协议|备案|许可|版权|法律|声明|政策|服务条款|隐私政策|隐私声明|京 ICP|沪 ICP|粤 ICP|ICP 备|公网安备|copyright|privacy|terms|legal|cookie/i;

/**
 * 移除节点内的备案 / 隐私 / 条款等合规链接。
 *
 * 背景：重写后页面理论上已无这些内容，但直答区（#b_context .b_ans）
 * 是唯一保留的原站节点，其内部常混入此类链接，
 * 会在纯结果列表里显得突兀，故显式剔除。
 */
function stripComplianceLinks(root: HTMLElement): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const href = a.getAttribute('href') ?? '';
    if (COMPLIANCE_PATTERN.test(text) || COMPLIANCE_PATTERN.test(href)) {
      // 优先删整个包裹元素，避免留下空白段落
      const block = a.closest('li, p, div') ?? a;
      block.remove();
    }
  });
}

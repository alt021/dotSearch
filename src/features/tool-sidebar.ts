/**
 * 右侧工具栏
 *
 * 替代原先的 Tampermonkey 弹出菜单，为「必应账户 / Rewards / 搜索设置」
 * 提供常驻入口 —— 这三处原站入口随顶栏一起被移除，重写后需要一个替代品。
 *
 * 交互设计：
 *   收起（默认）—— 完全移出视口外，不打扰阅读
 *   露出（peek）—— 鼠标移到屏幕右边缘时滑出一小条，提示此处可点
 *   展开（open）  —— 点击该条后整块滑入
 *
 * 三个入口都指向 Bing 自己的页面。
 * 注意：原站头部的账户与 Rewards 入口其实是 JS 弹层
 * （href="javascript:void(0)"），清空 DOM 后其脚本已失效，
 * 因此只能指向对应页面，而无法唤起原生弹层。
 */
import type { Feature } from '../types/feature.js';
import { log } from '../core/env.js';

/** 侧边栏根元素 id */
export const SIDEBAR_ID = 'se-toolbar';

/** 鼠标进入距右边缘该宽度内时露出侧边栏 */
const PEEK_ON = 16;

/**
 * 收回阈值，明显大于露出阈值 —— 这是刻意的「迟滞」。
 *
 * 若进出用同一个阈值，鼠标在边界附近稍有抖动就会反复露缩，
 * 那条提示会从指针底下溜走，反而点不中。
 * 拉开两个阈值后：一旦露出就稳住，直到指针离开较远才收回。
 */
const PEEK_OFF = 64;

interface ToolLink {
  label: string;
  hint: string;
  href: string;
}

/**
 * 三个入口地址均已实测验证（会正确落到 Bing 自家页面）：
 *   - 登录端点 → login.live.com，页面标题「登录」
 *   - Rewards  → rewards.bing.com/dashboard，未登录时转登录页
 *   - 设置     → bing.com/account/general，页面标题「搜索 - 设置」
 */
const TOOL_LINKS: ToolLink[] = [
  {
    label: '必应账户登录',
    hint: 'Account',
    href:
      'https://www.bing.com/fd/auth/signin?action=interactive' +
      '&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F',
  },
  {
    label: 'Microsoft Rewards',
    hint: 'Rewards',
    href: 'https://rewards.bing.com/dashboard',
  },
  {
    label: '搜索设置',
    hint: 'Settings',
    href: 'https://www.bing.com/account/general',
  },
];

/** 当前挂载的清理函数；卸载时统一执行 */
let cleanups: Array<() => void> = [];

export const toolSidebar: Feature = {
  id: 'tool-sidebar',
  name: '右侧工具栏',
  description: '在屏幕右边缘提供必应账户、Rewards 与搜索设置入口。',
  engines: 'all',

  supports() {
    return true;
  },

  onNavigate() {
    // 幂等：已挂载则不重复插入（页面重建后仍存在，无需重来）
    if (document.getElementById(SIDEBAR_ID)) return;

    const layer = buildSidebar();
    const bar = layer.querySelector<HTMLElement>(`.se-toolbar`);
    if (!bar) return;

    document.body.appendChild(layer);

    cleanups = [];
    wireInteraction(bar, cleanups);
    log.info('侧边栏已挂载');
  },

  dispose() {
    for (const off of cleanups) off();
    cleanups = [];
    // 连裁切层一起移除，避免留下空壳
    document.getElementById(SIDEBAR_ID)?.parentElement?.remove();
  },
};

/** 构建侧边栏 DOM */
function buildSidebar(): HTMLElement {
  /*
   * 外层「裁切层」—— 这一层不是装饰，是必需的：
   *
   * 收起时整块工具栏位于视口右侧之外。若不裁切，这 300 多像素的
   * 溢出会被浏览器计入文档可滚动区域，从而**反复触发横向滚动条**，
   * 连带 innerWidth / innerHeight 抖动、页面布局位移。
   * （实测 innerWidth 在运行中变动约 24px，正是由此而来。）
   *
   * 裁切层固定在视口上并 overflow:hidden，把溢出挡住；
   * 自身 pointer-events:none，不干扰页面交互，只有工具栏接收事件。
   * 工具栏用 absolute 定位，才能被该层正确裁切
   * （fixed 后代不受祖先 overflow 约束）。
   */
  const layer = document.createElement('div');
  layer.className = 'se-toolbar-layer';

  const bar = document.createElement('aside');
  bar.id = SIDEBAR_ID;
  bar.className = 'se-toolbar';
  bar.setAttribute('aria-label', '必应工具');

  // 露出的那一条：既是「可点」的提示，也是展开按钮
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'se-toolbar-tab';
  tab.setAttribute('aria-label', '打开必应工具');
  tab.setAttribute('aria-expanded', 'false');
  tab.setAttribute('aria-controls', 'se-toolbar-panel');

  // 用纯 CSS 画箭头，避免引入图标依赖
  const chevron = document.createElement('span');
  chevron.className = 'se-toolbar-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  tab.appendChild(chevron);

  const panel = document.createElement('div');
  panel.className = 'se-toolbar-panel';
  panel.id = 'se-toolbar-panel';
  /*
   * 收起时用 inert 屏蔽整块面板：
   * 它此时在视口外，若不屏蔽，Tab 键仍会走进去、
   * 屏幕阅读器也会读到不可见的内容。
   */
  panel.toggleAttribute('inert', true);

  const head = document.createElement('div');
  head.className = 'se-toolbar-head';

  const title = document.createElement('p');
  title.className = 'se-toolbar-title';
  title.textContent = '必应工具';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'se-toolbar-close';
  close.setAttribute('aria-label', '关闭必应工具');
  close.textContent = '关闭';

  head.append(title, close);

  const nav = document.createElement('nav');
  nav.className = 'se-toolbar-nav';
  nav.setAttribute('aria-label', '必应功能入口');

  for (const link of TOOL_LINKS) {
    const a = document.createElement('a');
    a.className = 'se-toolbar-link';
    a.href = link.href;
    // 与结果链接保持一致：新标签页打开，且不泄漏 referrer
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const label = document.createElement('span');
    label.className = 'se-toolbar-link-label';
    label.textContent = link.label;

    const hint = document.createElement('span');
    hint.className = 'se-toolbar-link-hint';
    hint.textContent = link.hint;

    a.append(label, hint);
    nav.appendChild(a);
  }

  panel.append(head, nav);
  // tab 在前、panel 在后：收起时整块右移，恰好只留 tab 露在屏幕边缘
  bar.append(tab, panel);
  layer.appendChild(bar);

  return layer;
}

/** 绑定交互：边缘露出、点击展开、关闭与键盘操作 */
function wireInteraction(bar: HTMLElement, off: Array<() => void>): void {
  const tab = bar.querySelector<HTMLElement>('.se-toolbar-tab');
  const panel = bar.querySelector<HTMLElement>('.se-toolbar-panel');
  const close = bar.querySelector<HTMLElement>('.se-toolbar-close');
  if (!tab || !panel || !close) return;

  const isOpen = (): boolean => bar.classList.contains('se-open');

  const setOpen = (open: boolean): void => {
    bar.classList.toggle('se-open', open);
    // 关闭时一并清掉露出态，否则移开鼠标前会残留半开
    bar.classList.remove('se-peek');
    tab.setAttribute('aria-expanded', String(open));
    panel.toggleAttribute('inert', !open);
  };

  /*
   * 露出提示：鼠标靠近屏幕右边缘时滑出一小条。
   *
   * 之所以用 JS 而非纯 CSS：CSS 感知不到「距右边缘的距离」，
   * 只能放一个常驻窄条用 :hover 触发 —— 那会挡住所覆盖区域的点击。
   *
   * 露出与收回用不同阈值（迟滞），见 PEEK_OFF 的说明。
   */
  const onMove = (event: MouseEvent): void => {
    if (isOpen()) return;
    const distance = window.innerWidth - event.clientX;
    // distance < 0 表示指针已在内容区之外（如压在滚动条上），
    // 此时不应触发露出，故要求距离非负。
    if (distance >= 0 && distance <= PEEK_ON) bar.classList.add('se-peek');
    else if (distance > PEEK_OFF) bar.classList.remove('se-peek');
  };
  document.addEventListener('mousemove', onMove);
  off.push(() => document.removeEventListener('mousemove', onMove));

  /*
   * 展开用 pointerdown 而非 click。
   *
   * 理由：这一条本身就是「会动的目标」—— 它在滑入过渡中位置还在变，
   * 而 click 要求 down 与 up 落在同一元素上；若按下与松开之间
   * 元素移开了一点，click 事件就不会生成，表现为「点了没反应」。
   * pointerdown 在按下瞬间即触发，不受此影响，手感也更跟手。
   *
   * 键盘（Enter / 空格）不产生 pointerdown，只会触发 click，
   * 故保留 click 监听，并用 detail === 0 区分键盘触发的 click
   * （鼠标 click 的 detail 为点击次数，键盘为 0），避免重复切换。
   */
  const toggle = (): void => setOpen(!isOpen());

  tab.addEventListener('pointerdown', toggle);
  off.push(() => tab.removeEventListener('pointerdown', toggle));

  const onTabKeyClick = (event: MouseEvent): void => {
    if (event.detail !== 0) return; // 鼠标 click 已由 pointerdown 处理
    toggle();
  };
  tab.addEventListener('click', onTabKeyClick);
  off.push(() => tab.removeEventListener('click', onTabKeyClick));

  const onClose = (): void => setOpen(false);
  close.addEventListener('click', onClose);
  off.push(() => close.removeEventListener('click', onClose));

  // Esc 关闭
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  };
  document.addEventListener('keydown', onKey);
  off.push(() => document.removeEventListener('keydown', onKey));

  // 点击面板外部关闭（点在栏内保留）
  const onDocClick = (event: MouseEvent): void => {
    if (!isOpen() || bar.contains(event.target as Node)) return;
    setOpen(false);
  };
  document.addEventListener('click', onDocClick);
  off.push(() => document.removeEventListener('click', onDocClick));
}

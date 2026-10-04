/**
 * 页头菜单（popup）
 *
 * 在页头小标题「BING — 检索」那一行的末尾放一个「菜单」文字按钮，
 * 点开后弹出必应账户、Rewards 与搜索设置的入口。
 *
 * 这三处原站入口随顶栏一起被移除，重写后需要一个替代品。
 *
 * ## 为什么挂在页头而不是自己做浮层
 *
 * 之前试过在屏幕右边缘做抽屉式侧边栏，但那一版引入了一堆麻烦：
 * 要处理贴边触摸区、滑入动画期间目标会移动、隐藏面板撑出横向滚动条等。
 * 改成页头内的 popup 后这些全都不存在 ——
 * 按钮是文档流内的普通元素，位置稳定，也不需要遮罩层。
 *
 * ## 入口指向
 *
 * 账户与 Rewards 在原站其实是 JS 弹层（href="javascript:void(0)"），
 * 清空 DOM 后其脚本已失效，因此只能指向对应页面。
 */
import type { Feature } from '../types/feature.js';
import { log } from '../core/env.js';
import { getBingSession } from './bing-session.js';
import { MENU_SLOT_CLASS, rerenderResults } from './strip-to-results.js';
import { openFilterPanel } from './filter-panel.js';

/** 菜单按钮的类名（同时也是幂等判据） */
export const MENU_BUTTON_CLASS = 'se-menu-btn';

/** 「结果过滤设置」按钮的类名，验证脚本据此定位 */
export const FILTER_ENTRY_CLASS = 'se-menu-filter';

/** 弹出面板 id，供 aria-controls 引用 */
const POPUP_ID = 'se-menu-popup';

/** 未登录时的登录入口（实测会落到 login.live.com 的登录页） */
const SIGN_IN_URL =
  'https://www.bing.com/fd/auth/signin?action=interactive' +
  '&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F';

/** 已登录时的去向：微软账户官网 */
const MICROSOFT_ACCOUNT_URL = 'https://account.microsoft.com/';

interface MenuEntry {
  label: string;
  href: string;
}

/**
 * 固定条目的地址均已实测验证（会正确落到 Bing 自家页面）：
 *   - Rewards → rewards.bing.com/dashboard，未登录时转登录页
 *   - 设置   → bing.com/account/general，页面标题「搜索 - 设置」
 */
const FIXED_ENTRIES: MenuEntry[] = [
  { label: 'Microsoft Rewards', href: 'https://rewards.bing.com/dashboard' },
  { label: '搜索设置', href: 'https://www.bing.com/account/general' },
];

/**
 * 生成账户条目。
 *
 * 已登录 → 「已作为 X 登录」，去微软账户官网
 * 未登录 → 「点击登录 Bing」，去必应登录端点
 *
 * 会话状态在页面被重写前采集（见 bing-session.ts），
 * 因为判据所在的顶栏已被清掉。
 */
function buildAccountEntry(): MenuEntry {
  const session = getBingSession();
  if (session.signedIn) {
    return {
      label: session.name ? `已作为 ${session.name} 登录` : '已登录必应',
      href: MICROSOFT_ACCOUNT_URL,
    };
  }
  return { label: '点击登录 Bing', href: SIGN_IN_URL };
}

/** 当前挂载的清理函数 */
let cleanups: Array<() => void> = [];

export const toolMenu: Feature = {
  id: 'tool-menu',
  name: '页头菜单',
  description: '在页头小标题行末提供必应账户、Rewards 与搜索设置入口。',
  engines: 'all',

  supports() {
    return true;
  },

  onNavigate() {
    const slot = document.querySelector<HTMLElement>(`.${MENU_SLOT_CLASS}`);
    if (!slot) {
      // 页面尚未重写或页头结构变了，不静默失败
      log.warn('未找到菜单挂载点，页头菜单未挂载');
      return;
    }
    // 幂等：已挂载则不重复插入
    if (slot.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const { button, popup } = buildMenu();
    slot.append(button, popup);

    cleanups = [];
    wire(button, popup, cleanups);
    log.info('页头菜单已挂载');
  },

  dispose() {
    for (const off of cleanups) off();
    cleanups = [];
    // 只清掉自己插入的两个节点，页头其余部分保持不动
    document.querySelector(`.${MENU_BUTTON_CLASS}`)?.remove();
    document.getElementById(POPUP_ID)?.remove();
  },
};

/** 构建「菜单」按钮与弹出面板 */
function buildMenu(): { button: HTMLButtonElement; popup: HTMLElement } {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = MENU_BUTTON_CLASS;
  button.textContent = '菜单';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', POPUP_ID);

  const popup = document.createElement('div');
  popup.className = 'se-menu-popup';
  popup.id = POPUP_ID;
  popup.setAttribute('role', 'menu');
  // 收起时用 inert 屏蔽：否则 Tab 仍会走进去、屏幕阅读器也会读到不可见内容
  popup.toggleAttribute('inert', true);

  const nav = document.createElement('nav');
  nav.className = 'se-menu-nav';
  nav.setAttribute('aria-label', '必应功能入口');

  /*
   * 结果过滤设置放在最前。
   * 它是本脚本自己的功能，与后面三个「原站入口替代品」性质不同，
   * 放最前也最容易被找到。
   */
  nav.appendChild(buildFilterEntry());

  for (const entry of [buildAccountEntry(), ...FIXED_ENTRIES]) {
    const a = document.createElement('a');
    a.className = 'se-menu-link';
    a.href = entry.href;
    // 与结果链接保持一致：新标签页打开，且不泄漏 referrer
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('role', 'menuitem');

    /*
     * 文字放进独立的 span，而不是直接作为 <a> 的文本。
     *
     * 外面套一层 span 并非多余：样式表（浏览器默认、其他扩展、
     * 或本脚本的旧版本残留）常会给 a:hover 加 text-decoration: underline。
     * 而 text-decoration **不会传播进原子行内元素**，
     * 因此把文字放进 display: inline-block 的 span，
     * 那些下划线就到不了文字上 —— 相当于把「链接」与「文字」分开。
     */
    const label = document.createElement('span');
    label.className = 'se-menu-label';
    label.textContent = entry.label;

    a.appendChild(label);
    nav.appendChild(a);
  }

  popup.appendChild(nav);
  return { button, popup };
}

/**
 * 「结果过滤设置」入口。
 *
 * 与其他条目不同，它是 <button> 而非 <a> ——
 * 这里不跳转，只打开一层设置浮层。
 * 但仍套一层 span，理由与其他条目一致：
 * 挡住外部样式表可能加在链接 / 按钮上的 text-decoration，
 * 那类装饰不会传播进原子行内元素。
 */
function buildFilterEntry(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `se-menu-link ${FILTER_ENTRY_CLASS}`;
  button.setAttribute('role', 'menuitem');

  const label = document.createElement('span');
  label.className = 'se-menu-label';
  label.textContent = '结果过滤设置';

  button.appendChild(label);
  button.addEventListener('click', () => {
    openFilterPanel(() => {
      // 规则变化后立即重建列表，用户关不关面板都能看到效果
      if (!rerenderResults()) log.warn('未找到结果列表，过滤改动将在下次重写后生效');
    });
  });
  return button;
}

/** 绑定开关与关闭行为 */
function wire(
  button: HTMLElement,
  popup: HTMLElement,
  off: Array<() => void>,
): void {
  const isOpen = (): boolean => !popup.hasAttribute('inert');

  const setOpen = (open: boolean): void => {
    popup.toggleAttribute('inert', !open);
    popup.classList.toggle('se-menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('se-menu-btn-active', open);
  };

  /*
   * 开关用 pointerdown 而非 click。
   * 与先前侧边栏同一个理由：click 要求按下与松开落在同一元素上，
   * 而菜单展开时按钮下方会插入面板、可能引起重排；
   * pointerdown 在按下瞬间即触发，不受影响。
   * 键盘（Enter / 空格）不产生 pointerdown，故保留 click 并以
   * event.detail === 0 区分，避免鼠标操作被切换两次。
   */
  const toggle = (): void => setOpen(!isOpen());

  button.addEventListener('pointerdown', toggle);
  off.push(() => button.removeEventListener('pointerdown', toggle));

  const onKeyClick = (event: MouseEvent): void => {
    if (event.detail !== 0) return; // 鼠标点击已由 pointerdown 处理
    toggle();
  };
  button.addEventListener('click', onKeyClick);
  off.push(() => button.removeEventListener('click', onKeyClick));

  // 点面板内的条目后收起：链接在新标签页打开，本页不会跳走
  const onLinkClick = (): void => setOpen(false);
  popup.addEventListener('click', onLinkClick);
  off.push(() => popup.removeEventListener('click', onLinkClick));

  // Esc 关闭
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  };
  document.addEventListener('keydown', onKey);
  off.push(() => document.removeEventListener('keydown', onKey));

  // 点击外部关闭（点在按钮或面板内则保留）
  const onDocPointerDown = (event: PointerEvent): void => {
    if (!isOpen()) return;
    const target = event.target as Node | null;
    if (target && (button.contains(target) || popup.contains(target))) return;
    setOpen(false);
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  off.push(() => document.removeEventListener('pointerdown', onDocPointerDown, true));
}

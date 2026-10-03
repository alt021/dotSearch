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
import { MENU_SLOT_CLASS } from './strip-to-results.js';

/** 菜单按钮的类名（同时也是幂等判据） */
export const MENU_BUTTON_CLASS = 'se-menu-btn';

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

  for (const entry of [buildAccountEntry(), ...FIXED_ENTRIES]) {
    const a = document.createElement('a');
    a.className = 'se-menu-link';
    a.href = entry.href;
    // 与结果链接保持一致：新标签页打开，且不泄漏 referrer
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('role', 'menuitem');
    a.textContent = entry.label;
    nav.appendChild(a);
  }

  popup.appendChild(nav);
  return { button, popup };
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

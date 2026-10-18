/**
 * 页头菜单（popup）
 *
 * 在页头小标题「<引擎> — 检索」那一行的末尾放一个「菜单」文字按钮，
 * 点开后弹出该引擎的账户、站内功能入口，以及本脚本自己的「附加设置」。
 *
 * 这些原站入口随顶栏一起被移除，重写后需要一个替代品。
 *
 * ## 为什么挂在页头而不是自己做浮层
 *
 * 之前试过在屏幕右边缘做抽屉式侧边栏，但那一版引入了一堆麻烦：
 * 要处理贴边触摸区、滑入动画期间目标会移动、隐藏面板撑出横向滚动条等。
 * 改成页头内的 popup 后这些全都不存在 ——
 * 按钮是文档流内的普通元素，位置稳定，也不需要遮罩层。
 *
 * ## 引擎差异在哪里
 *
 * 账户条目与站内入口**全部由引擎适配器提供**（getAccountEntry /
 * getExtraEntries），本模块不再认识「必应」「微软账户」这些概念。
 * 接新引擎时，菜单会自动呈现出该引擎自己的入口 ——
 * 引擎没实现对应钩子，就只是少几条，不会渲染空壳或报错。
 */
import type { Feature } from '../types/feature.js';
import type { EngineAdapter, MenuEntry } from '../types/engine.js';
import { log } from '../core/env.js';
import { MENU_SLOT_CLASS } from './strip-to-results.js';
import { openSettingsPanel } from './settings-panel.js';

/** 菜单按钮的类名（同时也是幂等判据） */
export const MENU_BUTTON_CLASS = 'se-menu-btn';

/**
 * 「附加设置」按钮的类名，验证脚本据此定位。
 *
 * 早前这里是「结果过滤设置」的直接入口（se-menu-filter）；
 * 现在过滤设置收进了附加设置弹窗，菜单首项变成一个开关面板的入口。
 */
export const SETTINGS_ENTRY_CLASS = 'se-menu-settings';

/** 弹出面板 id，供 aria-controls 引用 */
const POPUP_ID = 'se-menu-popup';

/**
 * 收集本次菜单要展示的**外链**条目。
 *
 * 顺序即展示顺序：账户条目在最前（它最常被用到），
 * 其后是引擎自己的站内入口。
 *
 * ## 账户条目始终显示
 *
 * 早前「净化链接」还叫「搜索隐私增强」时，开启后会隐藏账户条目，
 * 意图是让界面不提示身份。但那样做的副作用很糟：
 * 用户反而**无从确认自己的登录状态**（见下文说明）。
 * 该顾虑已随 Cookie 方案一并消失 —— 净化链接只改地址栏，
 * 不影响登录态，也就没有理由再藏账户入口。
 */
function collectEntries(engine: EngineAdapter): MenuEntry[] {
  const entries: MenuEntry[] = [];

  const account = engine.getAccountEntry?.();
  if (account) entries.push(account);

  entries.push(...(engine.getExtraEntries?.() ?? []));
  return entries;
}

/** 当前挂载的清理函数 */
let cleanups: Array<() => void> = [];

export const toolMenu: Feature = {
  id: 'tool-menu',
  name: '页头菜单',
  description: '在页头小标题行末提供该引擎的账户与站内功能入口。',
  engines: 'all',

  supports() {
    return true;
  },

  onNavigate({ engine }) {
    const slot = document.querySelector<HTMLElement>(`.${MENU_SLOT_CLASS}`);
    if (!slot) {
      // 页面尚未重写或页头结构变了，不静默失败
      log.warn('未找到菜单挂载点，页头菜单未挂载');
      return;
    }
    // 幂等：已挂载则不重复插入
    if (slot.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const { button, popup } = buildMenu(engine);
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
function buildMenu(engine: EngineAdapter): { button: HTMLButtonElement; popup: HTMLElement } {
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
  nav.setAttribute('aria-label', `${engine.name} 功能入口`);

  /*
   * 「附加设置」放最前。
   * 它是本脚本自己的设置入口，与后面几个「原站入口替代品」性质不同，
   * 放最前也最容易被找到。
   */
  nav.appendChild(buildSettingsEntry(engine));

  /*
   * 账户条目与站内入口全部来自适配器，见 collectEntries。
   * 隐私模式下账户条目不渲染（不登出，只是不提示）。
   */
  for (const entry of collectEntries(engine)) {
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
 * 「附加设置」入口。
 *
 * 与其他条目不同，它是 <button> 而非 <a> ——
 * 这里不跳转，只打开一层设置弹窗。
 * 但仍套一层 span，理由与其他条目一致：
 * 挡住外部样式表可能加在链接 / 按钮上的 text-decoration，
 * 那类装饰不会传播进原子行内元素。
 */
function buildSettingsEntry(engine: EngineAdapter): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `se-menu-link ${SETTINGS_ENTRY_CLASS}`;
  button.setAttribute('role', 'menuitem');

  const label = document.createElement('span');
  label.className = 'se-menu-label';
  label.textContent = '附加设置';

  button.appendChild(label);
  button.addEventListener('click', () => {
    openSettingsPanel({ engine });
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

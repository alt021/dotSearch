/**
 * 「附加设置」弹窗
 *
 * 页头菜单的第一项。把本脚本自己的设置收进一层弹窗里：
 * 菜单本身只保留「去哪」，不直接操作开关 ——
 * 开关放在弹窗里才有空间写清它到底做了什么。
 *
 * ## 与结果过滤面板的关系
 *
 * 结果过滤设置**不再是菜单里的一项**，而是本弹窗里的一行，
 * 点右侧「进入」打开原有的 .se-filter-panel。
 * 两个浮层的视觉语言一致（同一种遮罩、同一种描边面板），
 * 因此从「附加设置」进入过滤设置，看起来只是换了内容而不是换了界面。
 *
 * ## 弹窗自己不做遮罩外的复杂交互
 *
 * 关闭方式与过滤面板保持同一套：右上角 ×、点遮罩空白处、Esc。
 * 不额外做焦点陷阱 —— 面板是短列表，Esc 与点击遮罩已经足够，
 * 加焦点陷阱反而会与过滤面板的行为不一致。
 */
import { log } from '../core/env.js';
import { ROOT_ID, rerenderResults } from './strip-to-results.js';
import { openFilterPanel } from './filter-panel.js';
import { getSettings, setPrivacyEnabled } from './settings-store.js';
import { cleanAddressBar } from './privacy.js';
import type { EngineAdapter } from '../types/engine.js';

/** 弹窗根元素类名 */
export const SETTINGS_PANEL_CLASS = 'se-settings-panel';

/** 遮罩类名（与过滤面板同一套样式） */
const OVERLAY_CLASS = 'se-settings-overlay';

/** 净化开关的类名，验证脚本据此定位 */
export const PRIVACY_TOGGLE_CLASS = 'se-privacy-toggle';

/** 「进入」按钮的类名 */
export const FILTER_GOTO_CLASS = 'se-settings-goto';

interface SettingsPanelOptions {
  /** 当前引擎（开启净化后要立刻改写地址栏，需要知道搜索词参数名） */
  engine: EngineAdapter;
}

/**
 * 打开「附加设置」弹窗。
 *
 * @param options 当前引擎信息
 */
export function openSettingsPanel({ engine }: SettingsPanelOptions): void {
  // 幂等：已打开则不再叠一层
  if (document.querySelector(`.${SETTINGS_PANEL_CLASS}`)) return;

  const overlay = document.createElement('div');
  overlay.className = `${OVERLAY_CLASS} se-filter-overlay`;

  const panel = document.createElement('div');
  panel.className = SETTINGS_PANEL_CLASS;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '附加设置');

  // ---- 头部 ----
  const head = document.createElement('div');
  head.className = 'se-settings-head';
  const title = document.createElement('h2');
  title.className = 'se-settings-title';
  title.textContent = '附加设置';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'se-settings-close';
  /*
   * 与过滤面板同样的无障碍处理：视觉是「×」，读屏念的是「关闭附加设置」，
   * 因为「×」会被读成「乘号」。
   */
  close.setAttribute('aria-label', '关闭附加设置');
  close.title = '关闭';
  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '\u00d7';
  close.appendChild(glyph);
  head.append(title, close);

  // ---- 行 ----
  const rows = document.createElement('div');
  rows.className = 'se-settings-rows';

  rows.append(buildFilterRow(), buildPrivacyRow(engine));

  // ---- 底部留白区：后续设置项追加在这里 ----
  const tail = document.createElement('div');
  tail.className = 'se-settings-tail';

  panel.append(head, rows, tail);
  overlay.appendChild(panel);

  /*
   * 挂进 #se-root，而不是 body ——
   * 与过滤面板同一个理由（国际版有 MutationObserver 会摘掉 body 下的陌生节点）。
   * 详见 filter-panel.ts 的同名注释。
   */
  const host = document.getElementById(ROOT_ID) ?? document.body;
  host.appendChild(overlay);

  const onClose = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onClose();
  };
  close.addEventListener('click', onClose);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) onClose();
  });
  document.addEventListener('keydown', onKey);
}

/**
 * 「结果过滤设置」行：右侧「进入」打开原有的过滤面板。
 *
 * 进入后导航不回弹：过滤面板叠在同一层遮罩上，
 * 关闭过滤面板即回到本弹窗（两者是独立的浮层，各自管理自己的开合）。
 *
 * 说明文字写的是「能做什么」而不是「做了什么」：
 * 过滤的两种动作（加标签 / 隐藏）在面板里才展开，
 * 入口这一层只需要让人一眼知道这功能是干什么用的。
 */
function buildFilterRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'se-settings-row se-settings-row-stacked';

  const head = document.createElement('div');
  head.className = 'se-settings-row-head';

  const label = document.createElement('span');
  label.className = 'se-settings-label';
  label.textContent = '结果过滤设置';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = `se-settings-action ${FILTER_GOTO_CLASS}`;
  go.textContent = '进入';
  go.setAttribute('aria-label', '进入结果过滤设置');
  go.addEventListener('click', () => {
    openFilterPanel(() => {
      // 规则变化后立即重建列表，与原先菜单入口的行为一致
      if (!rerenderResults()) log.warn('未找到结果列表，过滤改动将在下次重写后生效');
    });
  });

  const hint = document.createElement('p');
  hint.className = 'se-settings-hint';
  hint.textContent = '屏蔽指定网站的搜索结果。';

  head.append(label, go);
  row.append(head, hint);
  return row;
}

/**
 * 净化链接的说明文案。
 *
 * 独立成常量，因为它同时被「净化链接」行使用、也被验证脚本断言 ——
 * 集中一处便于核对措辞，避免两处渐渐不一致。
 */
const BOUNDARY = '去除链接中的跟踪条目，其余不再变动。';

/**
 * 「净化链接」行：右侧一个开关。
 *
 * ## 这个开关实际做什么
 *
 * 开启后，把搜索结果页的地址栏改写为**只保留检索所需参数**的形式：
 * 去掉 cvid / form / IG / sp / pq 之类的追踪与识别参数，以及 #锚点。
 * 关闭后不再净化（已净化的地址不会自动加回参数 —— 那没有意义）。
 *
 * ## 为什么不做 Cookie 清理
 *
 * 早期版本尝试过「存档 → 清空 bing.com Cookie → 关闭时还原」，
 * 目标是让 Bing 端处于未登录。真机实测效果不佳：
 *   - GM_cookie 的签名在不同脚本管理器下不一致（回调式 / Promise 式）
 *   - Bing 会在页面加载与提交搜索时重新下发身份 Cookie，删了又长回来
 *   - 用户无法方便地确认 Bing 是否真的未登录（当时还会隐藏账户入口）
 * 一个「说得很强、实际不可靠」的功能，比没有这个功能更糟。
 * 现已整体移除，只保留**看得见、可验证**的链接净化。
 *
 * ## 边界
 *
 * 它只处理地址栏。Cookie、浏览器指纹（UA / Client Hints / TLS）、
 * IP 地址都不在它的作用范围内 —— 因此开关叫「净化链接」，
 * 而不是暗示用户已经安全了。
 */
function buildPrivacyRow(engine: EngineAdapter): HTMLElement {
  const row = document.createElement('div');
  row.className = 'se-settings-row se-settings-row-stacked';

  const head = document.createElement('div');
  head.className = 'se-settings-row-head';

  const label = document.createElement('span');
  label.className = 'se-settings-label';
  label.textContent = '净化链接';

  const enabled = getSettings().privacy;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `se-settings-switch ${PRIVACY_TOGGLE_CLASS}`;
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(enabled));
  toggle.setAttribute('aria-label', '净化链接');
  toggle.classList.toggle('se-settings-switch-on', enabled);

  // 轨道里的滑块：视觉是一个方块，不是圆角胶囊（瑞士风格拒绝圆角）
  const knob = document.createElement('span');
  knob.className = 'se-settings-knob';
  knob.setAttribute('aria-hidden', 'true');
  toggle.appendChild(knob);

  head.append(label, toggle);

  /*
   * 说明文字。
   *
   * 这一行不是装饰：开关的行为无法从「净化链接」四个字推断出来，
   * 不写用户容易高估它 —— 以为开了就匿名了。
   * 因此文案必须**主动划出能力边界**：它只管地址栏，
   * Cookie 与浏览器指纹都不在范围内。
   */
  const hint = document.createElement('p');
  hint.className = 'se-settings-hint';
  hint.textContent = BOUNDARY;

  toggle.addEventListener('click', () => {
    const next = !(toggle.getAttribute('aria-checked') === 'true');
    setPrivacyEnabled(next);
    toggle.setAttribute('aria-checked', String(next));
    toggle.classList.toggle('se-settings-switch-on', next);

    if (next) {
      // 立即把当前地址栏净化干净，用户能直接看到效果
      if (cleanAddressBar(engine.searchForm.param)) {
        log.info('净化链接：已去掉地址栏中的追踪参数');
      } else {
        log.info('净化链接：当前地址已无多余参数');
      }
    }
  });

  row.append(head, hint);
  return row;
}
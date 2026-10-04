/**
 * 结果过滤设置面板
 *
 * 由页头菜单的「结果过滤设置」打开，是一层居中浮层。
 *
 * ## 交互上的两个取舍
 *
 * 1. **改动即时生效、不设「保存」按钮**。域名列表本身就是最终状态，
 *    再加一步确认只是多余仪式；用户删掉一行就想立刻看到结果。
 *    因此每次改动都写回存储并回调 onApply，由 strip-to-results 重渲染。
 *
 * 2. **重渲染会重建列表**，这是本功能唯一可接受的「破坏性」刷新。
 *    过滤是全局性改动，重建后序号、隐藏态都需要重新计算，
 *    仅改动一条 DOM 反而更容易不一致。
 */
import { getRules, setRules, normalizeDomain, type FilterAction, type FilterRule } from './filter-store.js';

/** 设置浮层的根元素类名 */
export const FILTER_PANEL_CLASS = 'se-filter-panel';

const ACTIONS: Array<{ value: FilterAction; label: string }> = [
  { value: 'badge', label: '加「已排除」标签' },
  { value: 'hide', label: '隐藏该结果' },
];

/**
 * 打开设置面板。
 * @param onApply 规则变化后的回调（用于立即重渲染结果列表）
 */
export function openFilterPanel(onApply: () => void): void {
  // 幂等：已打开则不再叠一层
  if (document.querySelector(`.${FILTER_PANEL_CLASS}`)) return;

  const overlay = document.createElement('div');
  overlay.className = 'se-filter-overlay';

  const panel = document.createElement('div');
  panel.className = FILTER_PANEL_CLASS;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '结果过滤设置');

  const head = document.createElement('div');
  head.className = 'se-filter-head';
  const title = document.createElement('h2');
  title.className = 'se-filter-title';
  title.textContent = '结果过滤';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'se-filter-close';
  /*
   * 显示的是一枚「×」字形，但无障碍名不能是「×」——
   * 读屏会把它念成「乘号」，用户听不懂。
   * 因此视觉字形走 aria-hidden 的子元素，真正的名字用 aria-label 给。
   */
  close.setAttribute('aria-label', '关闭结果过滤设置');
  close.title = '关闭';
  const closeGlyph = document.createElement('span');
  closeGlyph.setAttribute('aria-hidden', 'true');
  closeGlyph.textContent = '\u00d7'; // ×
  close.appendChild(closeGlyph);
  head.append(title, close);

  const rows = document.createElement('div');
  rows.className = 'se-filter-rows';

  /** 用当前存储重画行；任何改动后调用，保证界面与存储一致 */
  const render = (): void => {
    rows.textContent = '';
    const rules = getRules();
    if (rules.length === 0) {
      // 空态：居中一条占位，明确告诉用户「这里还没有东西」
      const empty = document.createElement('p');
      empty.className = 'se-filter-empty';
      empty.textContent = '- EMPTY -';
      rows.appendChild(empty);
      return;
    }
    rules.forEach((rule, i) => rows.appendChild(buildRow(rule, i, commit)));
  };

  /** 按 DOM 顺序收集当前所有行，写回存储并触发回调 */
  const commit = (): void => {
    const next: FilterRule[] = [...rows.querySelectorAll<HTMLElement>('.se-filter-row')]
      .map((row) => ({
        domain: row.querySelector<HTMLInputElement>('.se-filter-domain')?.value ?? '',
        action: (row.querySelector<HTMLSelectElement>('.se-filter-action')?.value ??
          'badge') as FilterAction,
      }))
      .filter((r) => normalizeDomain(r.domain));
    setRules(next);
    render();
    onApply();
  };

  // 新增行
  const addWrap = document.createElement('div');
  addWrap.className = 'se-filter-add';
  const domainInput = document.createElement('input');
  domainInput.type = 'text';
  domainInput.className = 'se-filter-input';
  domainInput.placeholder = 'example.com';
  domainInput.setAttribute('aria-label', '要过滤的域名');
  const actionSelect = document.createElement('select');
  actionSelect.className = 'se-filter-select';
  actionSelect.setAttribute('aria-label', '对该域名的处理方式');
  for (const a of ACTIONS) {
    const opt = document.createElement('option');
    opt.value = a.value;
    opt.textContent = a.label;
    actionSelect.appendChild(opt);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'se-filter-add-btn';
  addBtn.textContent = '添加';

  const add = (): void => {
    const domain = normalizeDomain(domainInput.value);
    if (!domain) {
      // 无效输入不静默吞掉，给出可见反馈
      domainInput.classList.add('se-filter-input-invalid');
      domainInput.focus();
      return;
    }
    const rules = getRules();
    // 同域名重复添加视为「改动作」，而不是堆两条
    const existing = rules.findIndex((r) => r.domain === domain);
    const action = actionSelect.value as FilterAction;
    if (existing >= 0) rules[existing] = { domain, action };
    else rules.push({ domain, action });
    setRules(rules);
    domainInput.value = '';
    domainInput.classList.remove('se-filter-input-invalid');
    render();
    onApply();
    domainInput.focus();
  };

  addBtn.addEventListener('click', add);
  domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  domainInput.addEventListener('input', () => domainInput.classList.remove('se-filter-input-invalid'));
  addWrap.append(domainInput, actionSelect, addBtn);

  panel.append(head, rows, addWrap);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  render();

  // 关闭：按钮、点浮层空白处、Esc 三种方式
  const onClose = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };
  close.addEventListener('click', onClose);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onClose();
  });
  document.addEventListener('keydown', onKey);

  domainInput.focus();
}

/** 构建一行已存在的规则 */
function buildRow(rule: FilterRule, index: number, commit: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'se-filter-row';

  const domain = document.createElement('input');
  domain.type = 'text';
  domain.className = 'se-filter-domain';
  domain.value = rule.domain;
  domain.setAttribute('aria-label', `第 ${index + 1} 条规则的域名`);
  // 失焦即提交：避免逐字符写存储造成的抖动
  domain.addEventListener('change', commit);

  const action = document.createElement('select');
  action.className = 'se-filter-action';
  action.setAttribute('aria-label', `第 ${index + 1} 条规则的处理方式`);
  for (const a of ACTIONS) {
    const opt = document.createElement('option');
    opt.value = a.value;
    opt.textContent = a.label;
    action.appendChild(opt);
  }
  action.value = rule.action;
  action.addEventListener('change', commit);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'se-filter-remove';
  remove.textContent = '删除';
  remove.setAttribute('aria-label', `删除 ${rule.domain} 的规则`);
  remove.addEventListener('click', () => {
    row.remove();
    commit();
  });

  row.append(domain, action, remove);
  return row;
}

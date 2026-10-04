/**
 * 结果过滤的配置存储
 *
 * 用户配置的是「域名 → 动作」，动作只有两种：
 *   badge   在标题前加「已排除」标签（结果照常显示，仅作提示）
 *   hide    默认隐藏该结果，但保留序号与位置，可单击展开
 *
 * ## 为什么不用 GM_getValue / GM_setValue
 *
 * 那需要额外两条 @grant。而 localStorage 在本场景足够：
 * 数据量很小（几条域名），且读写都发生在页面内。
 * 少一条权限就少一分安装时的顾虑。
 *
 * ## 与 bing-session 的差别
 *
 * 登录状态是「页面级」信息，换一次搜索就该重新采集，用 sessionStorage；
 * 过滤配置是「用户级」偏好，要跨会话留着，所以用 localStorage。
 */

/** 匹配到的域名要做的事 */
export type FilterAction = 'badge' | 'hide';

/** 一条过滤规则 */
export interface FilterRule {
  /** 域名，如 csdn.net（小写，不含协议与路径） */
  domain: string;
  action: FilterAction;
}

const STORAGE_KEY = 'search-enhance:filter-rules';

/**
 * 需要保留三段主机的「多段后缀」。
 *
 * 这些后缀本身由两段组成（如 dpdns.org、us.kg），
 * 真正的注册域名是它的**上一层**：xxx.dpdns.org。
 * 若照「只留两段」的通用规则处理，会把 dpdns.org 当成注册域名，
 * 于是所有 *.dpdns.org 的站点被混为一谈 —— 那正是用户要避免的。
 *
 * 因此这份名单里的后缀，规范化后保留三段（xxx.xxx.xxx）。
 * 名单由用户给出，按需增补即可。
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'dpdns.org',
  'us.kg',
  'qzz.io',
  'xx.kg',
  'eu.org',
  'de5.net',
  'ggff.net',
  'finegear-sg.me',
  'eu.cc',
]);

/**
 * 域名规范化。
 *
 * 用户很可能直接粘贴一条完整搜索结果地址，所以这里容忍多种输入：
 *   https://blog.csdn.net/xxx?y=1  → csdn.net
 *   WWW.CSDN.NET/                  → csdn.net
 *   post.csdn.net                  → csdn.net
 *   csdn.net                       → csdn.net
 *   a.b.example.dpdns.org          → example.dpdns.org
 *
 * 目标是「按站点归并」：同一个站点的任意子域都收敛到同一条规则，
 * 用户不必为 blog./www./post. 分别配规则。
 * 做法是只保留注册域名那两段，中间多余的子域一律丢掉。
 *
 * 例外见 MULTI_LABEL_SUFFIXES：那些后缀本身两段，
 * 注册域名实际是三段，须保留三段。
 *
 * @returns 规范化后的域名；不像域名时返回空串
 */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) return '';
  // 去掉协议与路径，只留主机名
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/, 1)[0] ?? '';
  // 去掉端口与用户信息
  value = value.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  // 域名只允许这些字符，其余一律判为无效
  if (!/^[a-z0-9.-]+$/.test(value)) return '';
  // 去掉首尾的点（".csdn.net" / "csdn.net." 都出现过）
  value = value.replace(/^\.+|\.+$/g, '');
  // 连续的点或空标签一律判为无效
  if (value.includes('..')) return '';

  const parts = value.split('.');
  if (parts.length < 2) return '';

  /*
   * 先判多段后缀：取末两段看是否在名单里。
   * 命中则保留末三段（不足三段说明用户只写了后缀本身，保留原样）。
   */
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return parts.length <= 3 ? parts.join('.') : parts.slice(-3).join('.');
  }

  // 通用情形：只留注册域名那两段
  return parts.slice(-2).join('.');
}

/** 读取全部规则；存储损坏时返回空数组而不是抛错 */
export function getRules(): FilterRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    /*
     * 读的时候就重放一次规范化，而不是只做校验。
     *
     * 规范化规则是会变的（例如现在改成「只留两段」）。
     * 若只校验，旧数据里 blog.csdn.net 这种三段域名会因
     * normalizeDomain 之后不等而**被当成脏数据丢掉** ——
     * 用户升级版本后发现规则凭空消失，却没有任何提示。
     * 所以这里把旧的写法重新规范化，顺手合并去重。
     */
    const merged = new Map<string, FilterAction>();
    for (const value of parsed) {
      if (!value || typeof value !== 'object') continue;
      const r = value as Record<string, unknown>;
      if (typeof r.domain !== 'string') continue;
      if (r.action !== 'badge' && r.action !== 'hide') continue;
      const domain = normalizeDomain(r.domain);
      if (!domain) continue;
      // 后写的覆盖同域名的旧写法，与 setRules 保持一致
      merged.set(domain, r.action);
    }
    return [...merged].map(([domain, action]) => ({ domain, action }));
  } catch {
    return [];
  }
}

/** 覆盖写入全部规则（已做规范化与去重，后写的规则覆盖同域名旧规则） */
export function setRules(rules: FilterRule[]): void {
  const merged = new Map<string, FilterAction>();
  for (const rule of rules) {
    const domain = normalizeDomain(rule.domain);
    if (!domain) continue;
    merged.set(domain, rule.action === 'hide' ? 'hide' : 'badge');
  }
  const list = [...merged].map(([domain, action]) => ({ domain, action }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下可能不可写；此时本次会话内的过滤仍由内存态生效 */
  }
}

/**
 * 出结果地址命中的规则。
 *
 * 规则存的是规范化后的注册域名（两段，或多段后缀下三段），
 * 而结果地址可能带任意层子域，因此匹配也要先规范化一次：
 *   结果 blog.csdn.net  +  规则 csdn.net  → 命中（规范化后都是 csdn.net）
 *   结果 a.dpdns.org    +  规则 a.dpdns.org → 命中（三段后缀，整体保留）
 *
 * 基于规范化结果做**相等**比较即可，不必再做后缀匹配 ——
 * 规范化已经把子域收敛掉了，这也是它存在的意义。
 * 相等比后缀安全：不会出现 notcsdn.net 命中 csdn.net 这类误伤。
 *
 * 命中多条时取最长的那条，保留「整站标记 + 单站隐藏」的叠加能力
 * （多段后缀的规则天然比两段的更长）。
 */
export function matchRule(url: string | null | undefined, rules: FilterRule[]): FilterRule | null {
  if (!url) return null;
  const host = normalizeDomain(hostOf(url));
  if (!host) return null;

  let best: FilterRule | null = null;
  for (const rule of rules) {
    if (rule.domain !== host) continue;
    if (!best || rule.domain.length > best.domain.length) best = rule;
  }
  return best;
}

/** 取出主机名，解析失败返回空串（相对地址、非法地址都走这里） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 供设置面板与调试查看，当前是否已有任何规则 */
export function hasRules(): boolean {
  return getRules().length > 0;
}

/**
 * 结果过滤的配置存储
 *
 * 用户配置的是「域名 → 动作」，动作只有两种：
 *   badge   在标题前加「已排除」标签（结果照常显示，仅作提示）
 *   hide    默认隐藏该结果，但保留序号与位置，可单击展开
 *
 * ## 为什么用 GM_getValue / GM_setValue，而不是 localStorage
 *
 * 早期版本刻意避开了这两条 @grant，只用 localStorage，
 * 理由是「数据少、少一条权限少一分安装顾虑」。
 * 但那个判断漏掉了一件事：**localStorage 按源隔离**。
 *
 * 必应按 IP 分流 —— 直连落到 cn.bing.com，经代理落到 www.bing.com，
 * 两者是**不同的源**。于是用户在 cn 配好的规则，到 www 上
 * 既看不到、也改不动、更不生效，像是配置丢了。用户实际报过这个问题。
 *
 * 脚本管理器（Tampermonkey 等）的脚本级存储是**跨源共享**的：
 * 同一个脚本的所有 @match 共用一份，正好对症。
 * 代价是多两条 @grant —— 在「配置到底能不能用」面前，这笔账是划算的。
 *
 * localStorage 保留，但只承担两件事：
 *   1. **回退**：不在脚本管理器里运行时（控制台调试、本仓库的验证脚本）
 *      照常可用，不报错；
 *   2. **迁移与镜像**：旧版本只写 localStorage，首次读到共享存储
 *      「从未写过」时把它搬过去，用户升级后规则不会凭空消失。
 *
 * ## 与 bing-session 的差别
 *
 * 登录状态是「页面级」信息，换一次搜索就该重新采集，用 sessionStorage；
 * 过滤配置是「用户级」偏好，要跨会话、**跨站点**留着。
 *
 * ## 已知限制
 *
 * 跨标签实时同步没做（那需要再加 GM_addValueChangeListener）。
 * 改动会在**下一次重写**时生效：刷新页面，或在另一站点重新搜索。
 * 同一页面内改动是即时生效的（面板改完会立刻重建列表）。
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

/* -------------------------------------------------------------------------
 * 持久化：共享存储优先，localStorage 回退
 * ---------------------------------------------------------------------- */

/**
 * 共享存储（脚本级、跨源）是否可用。
 *
 * 用 `typeof` 判断而不是直接调用：标识符不存在时 `typeof` 不抛错，
 * 于是能在非脚本管理器环境下静默回退到 localStorage。
 */
function hasSharedStore(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

/**
 * 读共享存储。
 *
 * `present` 用来区分「从未写过」与「写成了空列表」——
 * 只有前者才该去迁移 localStorage 的旧数据。
 * 否则用户清空全部规则后，各源 localStorage 里那份旧数据会被反复搬回来。
 */
function readShared(): { present: boolean; raw: string | null } {
  if (!hasSharedStore()) return { present: false, raw: null };
  try {
    const value = GM_getValue<unknown>(STORAGE_KEY, null);
    if (value === null || value === undefined) return { present: false, raw: null };
    // 正常都是字符串（我们自己 JSON.stringify 后写入）；
    // 万一被写成了对象，兜一下，不至于整个规则列表读不出来。
    return { present: true, raw: typeof value === 'string' ? value : JSON.stringify(value) };
  } catch {
    return { present: false, raw: null };
  }
}

function writeShared(raw: string): void {
  if (!hasSharedStore()) return;
  try {
    GM_setValue(STORAGE_KEY, raw);
  } catch {
    /* 写失败不影响本次会话：面板改完会立刻重建列表，内存态是对的 */
  }
}

function readLocal(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocal(raw: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    /* 隐私模式等场景可能不可写 */
  }
}

/** 把原始 JSON 串解析成规则数组；顺带重放规范化、合并去重。损坏时返回空数组 */
function parseRules(raw: string | null): FilterRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  /*
   * 读的时候就重放一次规范化，而不是只做校验。
   *
   * 规范化规则是会变的（例如曾改成「只留两段」）。
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
}

/**
 * 读取全部规则；存储损坏时返回空数组而不是抛错。
 *
 * 顺序：共享存储 →（它「从未写过」时）把 localStorage 的旧数据迁移过去。
 * 迁移只发生一次：搬完共享存储里就有了值，各源此后读的是同一份。
 */
export function getRules(): FilterRule[] {
  const shared = readShared();
  if (shared.present) return parseRules(shared.raw);

  const legacy = parseRules(readLocal());
  if (legacy.length > 0) {
    // 旧版本只写 localStorage，这里补一次迁移，避免用户升级后规则消失
    writeShared(JSON.stringify(legacy));
  }
  return legacy;
}

/** 覆盖写入全部规则（已做规范化与去重，后写的规则覆盖同域名旧规则） */
export function setRules(rules: FilterRule[]): void {
  const merged = new Map<string, FilterAction>();
  for (const rule of rules) {
    const domain = normalizeDomain(rule.domain);
    if (!domain) continue;
    merged.set(domain, rule.action === 'hide' ? 'hide' : 'badge');
  }
  const raw = JSON.stringify([...merged].map(([domain, action]) => ({ domain, action })));

  /*
   * 共享存储是权威来源（cn / www 共用一份）；
   * localStorage 一并写，兼顾回退与镜像 ——
   * 后者让配置在 devtools 里可见，也让共享存储被清空时还能恢复。
   */
  writeShared(raw);
  writeLocal(raw);
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

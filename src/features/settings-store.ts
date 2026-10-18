/**
 * 「附加设置」的配置存储
 *
 * 与结果过滤（filter-store）分开，是因为两者性质不同：
 * 过滤规则是一份**列表**，附加设置是一组**开关**。
 * 混在一个键里会让「加一个开关」变成「迁移一份旧数据」。
 *
 * ## 存储选择：与 filter-store 保持一致
 *
 * 用 GM_getValue / GM_setValue（脚本级、跨源共享），
 * 而不是 localStorage。理由与 filter-store 完全相同：
 * 必应 cn.bing.com 与 www.bing.com 是两个源，
 * 而「隐私增强开没开」是用户级偏好，在 cn 上开了到 www 上必须还在开 ——
 * 否则用户会在不知情的情况下以「未开启」的状态去搜索。
 *
 * localStorage 仍然写一份，但只当**回退与镜像**：
 * 不在脚本管理器里运行时（控制台调试、验证脚本）照常可用；
 * 共享存储被清空时也能恢复。
 *
 * ## 未知键的处理
 *
 * 存储里是 JSON 对象，多出来的键会被原样保留 ——
 * 以后加开关（或回滚到旧版本）都不会把别人的设置抹掉。
 */

const STORAGE_KEY = 'search-enhance:settings';

/** 设置项的形状。新增开关时在这里加字段并给默认值 */
export interface Settings {
  /**
   * 净化链接。
   *
   * 开启后把搜索结果页地址栏改写为只保留检索所需参数的形式。
   *
   * 字段名沿用 `privacy` —— 该开关早前叫「搜索隐私增强」，
   * 后来因 Cookie 方案效果不佳而收窄为纯链接净化。
   * 名字没改是为了让已安装用户的设置**平滑延续**：
   * 改字段名会让旧值读不到，用户升完级发现开关变回默认关，
   * 却以为脚本坏了。
   */
  privacy: boolean;
}

/** 出厂默认值：全部关闭，避免升级后突然改变用户看到的页面 */
const DEFAULTS: Settings = {
  privacy: false,
};

/** 共享存储（脚本级、跨源）是否可用 */
function hasSharedStore(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

function readShared(): { present: boolean; raw: string | null } {
  if (!hasSharedStore()) return { present: false, raw: null };
  try {
    const value = GM_getValue<unknown>(STORAGE_KEY, null);
    if (value === null || value === undefined) return { present: false, raw: null };
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
    /* 写失败不影响本次会话：内存里的状态仍然正确 */
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

/** 把原始 JSON 解析成设置对象；损坏时返回空对象（由调用方与默认值合并） */
function parse(raw: string | null): Partial<Settings> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Partial<Settings>;
  } catch {
    return {};
  }
}

/** 合并默认值：只认已知键，且必须类型正确，避免脏数据把布尔字段变成字符串 */
function normalize(raw: Partial<Settings>): Settings {
  return {
    privacy: typeof raw.privacy === 'boolean' ? raw.privacy : DEFAULTS.privacy,
  };
}

/**
 * 读取全部设置。
 *
 * 顺序：共享存储 →（它「从未写过」时）把 localStorage 的镜像搬过去。
 * 与 filter-store 不同，这里不区分「从未写过」与「写成空对象」——
 * 设置对象永远有默认值兜底，不存在「迁移回来一堆旧数据」的问题。
 */
export function getSettings(): Settings {
  const shared = readShared();
  if (shared.present) return normalize(parse(shared.raw));

  const local = parse(readLocal());
  const settings = normalize(local);
  // 首次读到共享存储从未写过：把本地镜像搬过去，此后各源读同一份
  if (Object.keys(local).length > 0) writeShared(JSON.stringify(settings));
  return settings;
}

/** 写入一项设置（其余项保持原样） */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const next: Settings = { ...getSettings(), [key]: value };
  const raw = JSON.stringify(next);
  writeShared(raw);
  writeLocal(raw);
}

/** 搜索隐私增强是否开启 */
export function isPrivacyEnabled(): boolean {
  return getSettings().privacy;
}

/** 开关搜索隐私增强，返回写入后的状态 */
export function setPrivacyEnabled(enabled: boolean): boolean {
  setSetting('privacy', enabled);
  return enabled;
}

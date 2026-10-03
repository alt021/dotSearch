/**
 * 必应会话状态
 *
 * 用于右侧工具栏判断当前是否已登录必应，从而决定账户入口的文案与去向。
 *
 * ## 为什么必须单独「先采集、后使用」
 *
 * 判据全部来自必应顶栏（`#id_a` / `#id_l` / `#id_p`），
 * 而顶栏会被「重写结果页」功能整个清掉。
 * 又因为工具栏是在页面重建**之后**才挂载的（顺序见 features/index.ts），
 * 那时顶栏早已不存在。
 * 所以必须在清空 DOM 之前采集一次，缓存起来供后续使用。
 *
 * ## 判据（实测未登录页面的真实结构）
 *
 * ```html
 * <a id="id_l" href="javascript:void(0)">
 *   <div class="b_hide"><span class="cbtn">
 *     <input type="submit" value="登录">        <!-- 未登录时文案是「登录」 -->
 *   </span></div>
 *   <span id="id_a" aria-label="登录"></span>   <!-- 未登录时 aria-label 是「登录」 -->
 *   <img id="id_p" class="id_avatar" style="display:none">  <!-- 已登录才显示 -->
 * </a>
 * ```
 *
 * 因此「已登录」的最强信号是**头像图片被显示出来**（`#id_p` 不再 display:none）；
 * 其次是头像/按钮文案不再是「登录」而是用户名。
 *
 * 注意 `window._G.SUIH` **不可用**：未登录时它同样有值（会话哈希），
 * 与身份无关，实测已确认。
 *
 * ## 判不准时的取舍
 *
 * 两个信号都不成立时，按「未登录」处理。
 * 这样最坏情况是已登录用户被送去登录端点，
 * 而必应对已登录用户会直接放行 —— 不会卡在登录页；
 * 反之若误判为已登录，会让未登录用户跳到微软账户页，更突兀。
 */
import { log } from '../core/env.js';

export interface BingSession {
  /** 是否已登录 */
  signedIn: boolean;
  /** 已登录时的显示名；取不到则为 null */
  name: string | null;
}

/** 未采集到任何信息时的结果 */
const UNKNOWN: BingSession = { signedIn: false, name: null };

/** 「登录」文案：中英文常见写法 */
const SIGN_IN_RE = /^(登录|登入|登陆|Sign in|Sign in to your account|Iniciar sesión|サインイン)$/i;

/** 头像图片的默认 alt，属于占位文案而非用户名 */
const PLACEHOLDER_ALT_RE = /个人资料图片|profile picture|プロフィール画像/i;

let cached: BingSession | null = null;

/**
 * 从当前页面采集必应会话状态。
 * **必须在清空 DOM 之前调用**（见文件头说明）。
 */
export function captureBingSession(): void {
  try {
    cached = read();
    log.info(`必应会话：${cached.signedIn ? `已登录（${cached.name ?? '名未知'}）` : '未登录'}`);
  } catch (err) {
    // 采集失败不影响主流程：按未登录处理
    cached = UNKNOWN;
    log.warn('采集必应会话状态失败：', err);
  }
}

/** 读取已采集的会话状态；未采集过则按未登录处理 */
export function getBingSession(): BingSession {
  return cached ?? UNKNOWN;
}

/** 从 DOM 读出会话状态 */
function read(): BingSession {
  const avatar = document.getElementById('id_a');
  const avatarLabel = (avatar?.getAttribute('aria-label') ?? '').trim();

  const submit = document.querySelector<HTMLInputElement>('#id_l input[type="submit"]');
  const submitLabel = (submit?.value ?? submit?.getAttribute('aria-label') ?? '').trim();

  const profile = document.getElementById('id_p');
  const profileStyle = profile?.getAttribute('style') ?? '';
  const profileShown = profile !== null && !/display\s*:\s*none/i.test(profileStyle);

  const profileAlt = (profile?.getAttribute('data-alt') ?? profile?.getAttribute('alt') ?? '').trim();
  const usableAlt = PLACEHOLDER_ALT_RE.test(profileAlt) ? '' : profileAlt;

  /*
   * 已登录：头像图片显示出来，或文案已不是「登录」。
   * 后者要排除空文案 —— 空字符串不代表已登录。
   */
  const labelIsName =
    (avatarLabel !== '' && !SIGN_IN_RE.test(avatarLabel)) ||
    (submitLabel !== '' && !SIGN_IN_RE.test(submitLabel));

  if (profileShown || labelIsName) {
    const name = firstNonEmpty([usableAlt, avatarLabel, submitLabel]);
    return { signedIn: true, name: name === '' ? null : name };
  }

  return { signedIn: false, name: null };
}

/** 取第一个非空字符串 */
function firstNonEmpty(values: string[]): string {
  for (const v of values) {
    const t = v.trim();
    if (t !== '' && !SIGN_IN_RE.test(t)) return t;
  }
  return '';
}

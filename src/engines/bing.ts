import type { EngineAdapter, EngineSession, MenuEntry } from '../types/engine.js';
import { text } from '../core/dom.js';
import { log } from '../core/env.js';

/*
 * 必应的搜索前端。
 *
 * 必应有多个**等价**入口：www / cn / www2 / www4 …
 * 并且它按 IP 分流 —— 同一个域名在不同网络下给出中国版或全球版，
 * 备用子域本身也随可用性增删。
 *
 * 所以这里用**后缀判定**而不是白名单：
 * 白名单天生追不上必应增删别名，www4 就是这么漏掉的
 * （漏掉的后果不是「功能降级」，而是脚本静默退出、整个增强都不生效）。
 *
 * 实测（2026-10，桌面版）：
 *   www2 / www4        可直接作为搜索入口，DOM 与 www 一致
 *   www3 / www5 / www6 302 回 cn.bing.com 首页，构不成入口
 *   m / global         跳回 cn.bing.com/search
 *
 * 理论上的例外是移动站（`m.` 前缀）：那套 DOM 完全不同。
 * 但即使误判也没有破坏性 —— 找不到结果容器时重写会直接退出，
 * 不触碰页面（见 strip-to-results 里的容器判空）。
 */
function isBingHost(hostname: string): boolean {
  return hostname === 'bing.com' || hostname.endsWith('.bing.com');
}

const INJECT_FLAG = '__searchEnhanceBing__';

/**
 * Bing 适配器
 *
 * 以下结构基于 2026-10 抓取的真实结果页校准（zh-CN 桌面版）：
 *   li.b_algo                        单条自然结果
 *     a.tilk                         头部可点区（内含站点图标与显示 URL）
 *       div.b_tpcn                   站点图标
 *       div.tpmeta > div.b_attribution > cite   显示的 URL 文本
 *     h2 > a > strong                标题（真正的链接）
 *     div.b_caption > p.b_lineclamp2 摘要
 *
 * 注意：Bing 改版频繁。选择器失效时优先只改这里，
 * 不要把引擎专属选择器散落到 features/ 中。
 *
 * 关于跳转链接：Bing 的 href 均为 `bing.com/ck/a?...` 形式的跳转地址，
 * 真实目标地址在 `u=` 查询参数里（base64 + 补位字符），
 * 解析方式见 decodeBingRedirectUrl。
 */
export const bing: EngineAdapter = {
  id: 'bing',
  name: 'Bing',
  /*
   * 仅供日志与调试查看，**不求穷举** ——
   * 识别一律走 isBingHost 的后缀判定，新增备用子域不必改这里。
   */
  hostnames: ['www.bing.com', 'cn.bing.com', 'www2.bing.com', 'www4.bing.com', 'bing.com'],

  resultContainerSelector: '#b_results',
  resultItemSelector: 'li.b_algo',
  searchForm: { path: '/search', param: 'q' },

  isSearchPage(url) {
    return isBingHost(url.hostname) && url.pathname === '/search';
  },

  parseQuery(url) {
    return url.searchParams.get('q');
  },

  getAdSelectors() {
    return ['li.b_ad', 'li.b_adTop', '.b_adSlug', '.b_adBottom'];
  },

  extractResults(root) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('li.b_algo'));
    return nodes.map((node, index) => {
      // 标题链接在 h2 内；a.tilk 是头部整体可点区，仅作兜底
      const titleLink = node.querySelector<HTMLAnchorElement>('h2 a[href]');
      const clickable = node.querySelector<HTMLAnchorElement>('a.tilk[href]');
      const rawHref = (titleLink ?? clickable)?.href ?? null;

      return {
        node,
        link: titleLink ?? clickable,
        title: text(node.querySelector('h2')),
        snippet: text(node.querySelector('.b_caption p, p.b_lineclamp2, .b_lineclamp2')),
        // cite 里是 Bing 展示用的可读 URL，比跳转链接更适合作为来源显示
        displayUrl: text(node.querySelector('div.b_attribution cite, cite')),
        // 解析出真实目标地址，供后续跳转/去广告逻辑使用
        url: rawHref ? decodeBingRedirectUrl(rawHref) ?? rawHref : null,
        index,
      };
    });
  },

  isAlreadyInjected(doc) {
    return INJECT_FLAG in (doc as unknown as Record<string, unknown>);
  },

  markInjected(doc) {
    (doc as unknown as Record<string, unknown>)[INJECT_FLAG] = true;
  },

  unmarkInjected(doc) {
    delete (doc as unknown as Record<string, unknown>)[INJECT_FLAG];
  },

  /* ---------------- 账户会话（Bing 专有） ---------------- */

  captureSession() {
    try {
      session = readSession();
      log.info(`必应会话：${session.signedIn ? `已登录（${session.name ?? '名未知'}）` : '未登录'}`);
    } catch (err) {
      // 采集失败不影响主流程：按未登录处理
      session = UNKNOWN_SESSION;
      log.warn('采集必应会话状态失败：', err);
    }
  },

  getSession() {
    return session ?? UNKNOWN_SESSION;
  },

  getAccountEntry() {
    const s = this.getSession!();
    if (s.signedIn) {
      return {
        label: s.name ? `已作为 ${s.name} 登录` : '已登录必应',
        href: MICROSOFT_ACCOUNT_URL,
      };
    }
    return { label: '点击登录 Bing', href: signInUrl() };
  },

  getExtraEntries() {
    /*
     * Rewards 保持绝对地址：它在**另一个**子域上（rewards.bing.com），
     * 不是当前站点的路径，不能跟着 origin 走。
     * 「搜索设置」则相反 —— 四个入口各有自己的设置页，应该留在当前站点。
     */
    return [
      { label: 'Microsoft Rewards', href: 'https://rewards.bing.com/dashboard' },
      { label: '搜索设置', href: `${location.origin}/account/general` },
    ];
  },

  /* ---------------- 设置页（Bing 专有） ---------------- */

  isSettingsPage(url) {
    if (!isBingHost(url.hostname)) return false;
    return url.pathname.replace(/\/+$/, '') === '/account/general';
  },

  /**
   * 已被本脚本取代、或在本脚本重写后的页面上不成立的设置项。
   *
   * 结构基于 2026-10 抓取的 /account/general（zh-CN）实测：
   *
   *   #settings_suggestions          整个「搜索建议」分组
   *     #enAS                        键入时查看搜索建议
   *   #settings_results
   *     .b_vPanel                    包住下面两个「新窗口」开关
   *       #newwnd                    在新标签页或窗口中打开搜索结果链接
   *       #newsnt                    在新标签页或窗口中打开新闻结果链接
   *   .hpqs                          主页的两个显示开关（同一个容器）
   *
   * 隐藏的粒度是**能独立成块的整行**，不是单个 input ——
   * 只藏 input 会留下一行没有控件的空文字，比不藏更奇怪。
   */
  getSupersededSettings() {
    return [
      {
        /*
         * 结果链接的新窗口设置已被脚本接管：重写后的每条结果都是
         * target="_blank" 的锚点（见 strip-to-results 的 anchor.target）。
         * 用户在这里怎么选都不会改变结果页的行为。
         */
        selector: '.b_vPanel',
        label: '在新标签页或窗口中打开搜索结果链接',
        reason: '本脚本的结果列表始终在新标签页打开，此设置不再影响结果页',
      },
      {
        /*
         * 重写后的页面没有 Bing 原生的输入框与下拉建议 ——
         * 搜索框是我们自己建的，建议列表根本不存在。
         */
        selector: '#settings_suggestions',
        label: '键入时查看搜索建议',
        reason: '本脚本的搜索框不带原站建议列表，此设置不生效',
      },
      {
        /*
         * 「显示主页图片 / 菜单栏」只作用于 Bing 首页。
         * 本脚本只接管搜索结果页，首页保持原样 —— 但用户在结果页
         * 从来看不到这两项的效果，留着只会让人以为哪里不对。
         * 隐藏时说明得写准：这是我们**不管**，而不是我们取代了它。
         */
        selector: '.hpqs',
        label: '主页显示项',
        reason: '这两项只影响 Bing 首页，本脚本不改变首页行为',
      },
    ];
  },
};

/*
 * ============ 必应账户会话（原 features/bing-session.ts） ============
 *
 * ## 为什么必须单独「先采集、后使用」
 *
 * 判据全部来自必应顶栏（`#id_a` / `#id_l` / `#id_p`），
 * 而顶栏会被「重写结果页」功能整个清掉。
 * 又因为菜单是在页面重建**之后**才挂载的，
 * 那时顶栏早已不存在。
 * 所以必须在清空 DOM 之前采集一次（strip-to-results 负责调用 captureSession）。
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

/** 未采集到任何信息时的结果 */
const UNKNOWN_SESSION: EngineSession = { signedIn: false, name: null };

/** 本次页面采集到的会话状态 */
let session: EngineSession | null = null;

/** 「登录」文案：中英文常见写法 */
const SIGN_IN_RE = /^(登录|登入|登陆|Sign in|Sign in to your account|Iniciar sesión|サインイン)$/i;

/** 头像图片的默认 alt，属于占位文案而非用户名 */
const PLACEHOLDER_ALT_RE = /个人资料图片|profile picture|プロフィール画像/i;

/** 已登录时的去向：微软账户官网 */
const MICROSOFT_ACCOUNT_URL = 'https://account.microsoft.com/';

/**
 * 站内入口一律**跟随当前站点**，不写死 www.bing.com。
 *
 * 必应有多个等价入口（www / cn / www2 / www4 …），
 * 而用户改用备用域名，往往正是因为 www 那一侧访问不了 ——
 * 写死就会把这类用户又弹回一个打不开的域名上去。
 *
 * 实测这些路径在 www / cn / www2 / www4 上都存在：
 *   /fd/auth/signin    302 到各自的 /v2 变体，再转 login.live.com
 *   /account/general   直接 200，各自语言设置页
 */
function signInUrl(): string {
  const here = location.origin;
  return (
    `${here}/fd/auth/signin?action=interactive` +
    `&provider=windows_live_id&return_url=${encodeURIComponent(`${here}/`)}`
  );
}

/** 从 DOM 读出会话状态 */
function readSession(): EngineSession {
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

/**
 * 解析 Bing 跳转链接 `bing.com/ck/a?...&u=a1<base64url>`，
 * 取出真实目标地址。解析失败时返回 null，由调用方回退到原始 href。
 */
function decodeBingRedirectUrl(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.bing.com');
    const raw = url.searchParams.get('u');
    if (!raw) return null;

    // Bing 用 'a1' 作为 base64url 的前缀标记
    const b64 = raw.startsWith('a1') ? raw.slice(2) : raw;
    // base64url → base64：补齐 padding 并还原 URL 安全字符
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(padded);
    // 解出的是 UTF-8 字节，需按 UTF-8 还原为字符串
    const text = new TextDecoder('utf-8').decode(
      Uint8Array.from(decoded, (ch) => ch.charCodeAt(0)),
    );
    return /^https?:\/\//i.test(text) ? text : null;
  } catch {
    return null;
  }
}

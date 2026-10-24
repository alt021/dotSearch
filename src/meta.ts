/**
 * 单一元信息来源（source of truth）
 *
 * 这个文件会被 `scripts/build.mjs` 单独打包并导入，
 * 用来生成 UserScript 的 `// ==UserScript==` 头部。
 * 因此：只能有纯数据导出，不要 import 任何带副作用的模块。
 */

/**
 * 引擎标识。新增引擎时同步扩展此列表，types/engine.ts 会据此推导类型。
 */
export const ENGINE_IDS = ['bing', 'google', 'baidu'] as const;

/**
 * 注入页面的脚本权限。
 *
 * - `GM_addStyle`    注入样式表。
 * - `GM_getValue` / `GM_setValue`
 *   过滤规则与附加设置的持久化。**必须用脚本级存储而不是 localStorage**：
 *   必应按 IP 分流，cn.bing.com 与 www.bing.com 是两个源，
 *   而 localStorage 按源隔离 —— 用它会导致「在 cn 配好的规则
 *   到 www 上看不到也不生效」。脚本级存储跨源共享，正好对症。
 *
 * 早前移除 GM_getValue / GM_setValue 是判断失误（当时只考虑了数据量与权限面，
 * 漏了跨源这一条）；用户反馈配置不互通后改回。
 * 其余权限（GM_registerMenuCommand / GM_openInTab 等）仍不需要。
 *
 * `GM_cookie` 曾用于搜索隐私增强的 Cookie 清理，该能力已整体移除
 * （真机效果不佳），相应权限一并撤销 —— 少一个敏感权限，
 * 安装时的授权提示也更少。
 */
export const GRANTS = ['GM_addStyle', 'GM_getValue', 'GM_setValue'] as const;

/**
 * 各引擎的构建信息。
 *
 * 项目从「一个脚本兼容多引擎」改为「**每个引擎一个独立脚本**」：
 * 每个引擎有自己的 @match 集合与产物名，安装后互不干扰。
 * 共享的只有 core / types / 通用 features，它们由同一份源码编译。
 *
 * 新增引擎时在这里加一项：产物名、脚本体名、注入规则一次配齐。
 * 构建侧只需 `npm run build -- --engine=<id>`。
 */
export interface EngineBuild {
  /** 脚本体名，形如「dotSearch for Bing」 */
  displayName: string;
  /** 产物文件名中的引擎片段（dotSearch-<slug>.user.js） */
  slug: string;
  /** 该引擎生效的 @match 规则 */
  matches: string[];
}

export const ENGINE_BUILDS: Record<string, EngineBuild> = {
  bing: {
    displayName: 'dotSearch for Bing',
    slug: 'bing',
    /*
     * ⚠️ 第一条通配已覆盖必应的**全部**搜索前端：
     * www / cn / www2 / www4 …（以及以后新增的别名），
     * 因此**新增备用子域在功能上不需要改这里**。
     * 实测 www3 / www5 / www6 会 302 回 cn.bing.com 首页，构不成入口。
     *
     * 后两条相对通配是冗余的，保留是因为它们是**实际验收过、也希望用户用到**
     * 的入口：写出来既方便阅读排查，也让「脚本会在哪些站点上跑」
     * 在头部一目了然，不必去推导通配的语义。
     *
     * 真正决定「这个站点算不算必应搜索页」的是 engines/bing.ts 的
     * isBingHost（后缀判定）—— 那才是曾漏掉 www4、导致脚本静默退出的地方；
     * @match 只是**注入**门槛，两者缺一不可。
     */
    matches: [
      '// @match        *://*.bing.com/search*',
      '// @match        *://cn.bing.com/search*',
      '// @match        *://www4.bing.com/search*',
      /*
       * 设置页：脚本会在这里折叠已被取代的设置项。
       *
       * 用通配覆盖全部子域（cn / www2 / www4 …），
       * 与搜索页保持一致 —— 各入口的设置页是等价的，
       * 只给 www 加规则会导致「换个域进来就看不到折叠」。
       */
      '// @match        *://*.bing.com/account/general*',
    ],
  },

  google: {
    displayName: 'dotSearch for Google',
    slug: 'google',
    matches: [
      '// @match        *://www.google.com/search*',
      '// @match        *://www.google.com.hk/search*',
    ],
  },

  baidu: {
    displayName: 'dotSearch for Baidu',
    slug: 'baidu',
    matches: ['// @match        *://www.baidu.com/s*'],
  },
};

/** 默认构建的引擎 */
export const DEFAULT_ENGINE = 'bing';

/** 原 MATCHES_ACTIVE 的等价视图（保留给调试与文档引用） */
export const MATCHES_ACTIVE = ENGINE_BUILDS[DEFAULT_ENGINE]!.matches;

/** 本地开发服务地址，需与 scripts/serve.mjs 的端口一致 */
export const DEV_SERVER = 'http://127.0.0.1:8777';

/**
 * 产物文件名。
 *
 * 单一来源：构建脚本、本机安装地址、正式下载地址都从这里取，
 * 避免改名时漏掉某一处 —— 那会得到一条指向 404 的安装链接。
 */
export function artifactFor(engine: string = DEFAULT_ENGINE): string {
  const build = ENGINE_BUILDS[engine];
  if (!build) throw new Error(`未知引擎：${engine}`);
  return `dotSearch-${build.slug}.user.js`;
}

/** 默认引擎的产物名（兼容既有引用） */
export const ARTIFACT = artifactFor();

/** 项目主页（GitHub 仓库），三处 URL 都由它派生 */
const REPO = 'https://github.com/alt021/dotSearch';

/**
 * 仓库内文件的直链前缀。
 *
 * 与 REPO 分开列而不是从它拼：`raw.githubusercontent.com` 与 `github.com`
 * 是两个域，路径结构也不同（前者没有 `/blob/main` 这一段）。
 * 产物地址与图标地址都从这里派生，换仓库名只需改这一处。
 */
const RAW = 'https://raw.githubusercontent.com/alt021/dotSearch/main';

export const META = {
  namespace: REPO,
  homepage: REPO,
  supportURL: `${REPO}/issues`,
  /** 正式发布地址（推到 GitHub 后生效） */
  downloadURL: (artifact: string) => `${RAW}/dist/${artifact}`,
  /**
   * 脚本图标（脚本管理器的列表里显示的那一枚）。
   *
   * 早期借用了必应自己的青色 favicon —— 于是「脚本列表里的图标」与
   * 「页头品牌」是两套互不相干的视觉，页头是红方块、图标却是必应的。
   * 现在统一为项目自己的 mark：纯黑 + 瑞士红，透明底，无底板。
   *
   * 指向仓库内的 `assets/icon/dotsearch.svg`。与 @downloadURL 不同，
   * 这个文件**是源码、会随仓库提交**，所以推送后即可取到；
   * 深色底用的反白版是 `dotsearch-reverse.svg`（脚本管理器侧没有深色变体这个说法，
   * 故头部只用正版）。
   */
  icon: `${RAW}/assets/icon/dotsearch.svg`,
  runAt: 'document-start',
  noframes: true,
} as const;

export interface MetaOptions {
  version: string;
  description: string;
  /**
   * 目标引擎。决定脚本体名、@match 与产物名。
   * 缺省为 DEFAULT_ENGINE（必应）。
   */
  engine?: string;
  /**
   * 开发模式：把 @updateURL / @downloadURL 指向本机服务。
   * 这样 Tampermonkey 装上后能自动跟随本地重建，且不会去请求尚未存在的 GitHub 地址。
   */
  dev?: boolean;
}

/**
 * 生成注入到产物顶部的 UserScript 头部。
 *
 * @name 用「dotSearch for <引擎>」而不是统一叫 dotSearch：
 * 这样多个引擎的脚本可以**同时安装**在同一个脚本管理器里，
 * 彼此不会因为同名而互相覆盖或触发错误的自动更新。
 */
export function buildMetaBlock(pkg: MetaOptions): string {
  // 开发版附加 -dev 后缀，便于与正式版区分并触发 Tampermonkey 更新
  const version = pkg.dev ? `${pkg.version}-dev` : pkg.version;

  const engineId = pkg.engine ?? DEFAULT_ENGINE;
  const build = ENGINE_BUILDS[engineId];
  if (!build) throw new Error(`未知引擎：${engineId}`);

  const artifact = artifactFor(engineId);
  const remote = META.downloadURL(artifact);

  return [
    '// ==UserScript==',
    `// @name         ${build.displayName}${pkg.dev ? ' (Dev)' : ''}`,
    `// @version      ${version}`,
    `// @description  ${pkg.description}`,
    '// @author       AmeXE2',
    `// @namespace    ${META.namespace}`,
    `// @homepageURL  ${META.homepage}`,
    `// @supportURL   ${META.supportURL}`,
    // 开发模式下以本机服务为准，避免 Tampermonkey 校验 404 的远端地址
    `// @downloadURL  ${pkg.dev ? `${DEV_SERVER}/${artifact}` : remote}`,
    ...(pkg.dev ? [`// @updateURL    ${DEV_SERVER}/${artifact}`] : [`// @updateURL    ${remote}`]),
    `// @icon         ${META.icon}`,
    ...build.matches,
    ...GRANTS.map((g) => `// @grant        ${g}`),
    `// @run-at       ${META.runAt}`,
    ...(META.noframes ? ['// @noframes'] : []),
    '// ==/UserScript==',
    '',
  ].join('\n');
}

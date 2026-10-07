/**
 * 单一元信息来源（source of truth）
 *
 * 这个文件会被 `scripts/build.mjs` 单独打包并导入，
 * 用来生成 UserScript 的 `// ==UserScript==` 头部。
 * 因此：只能有纯数据导出，不要 import 任何带副作用的模块。
 */

/** 引擎标识。新增引擎时同步扩展此列表，types/engine.ts 会据此推导类型。 */
export const ENGINE_IDS = ['bing', 'google', 'baidu'] as const;

/**
 * 注入页面的脚本权限。
 *
 * - `GM_addStyle`    注入样式表。
 * - `GM_getValue` / `GM_setValue`
 *   过滤规则的持久化。**必须用脚本级存储而不是 localStorage**：
 *   必应按 IP 分流，cn.bing.com 与 www.bing.com 是两个源，
 *   而 localStorage 按源隔离 —— 用它会导致「在 cn 配好的规则
 *   到 www 上看不到也不生效」。脚本级存储跨源共享，正好对症。
 *
 * 早前移除这两个权限是判断失误（当时只考虑了数据量与权限面，
 * 漏了跨源这一条）；用户反馈配置不互通后改回。
 * 其余权限（GM_registerMenuCommand / GM_openInTab 等）仍不需要。
 */
export const GRANTS = ['GM_addStyle', 'GM_getValue', 'GM_setValue'] as const;

/**
 * @match 规则 —— 已接入适配器的引擎。
 * Google / 百度未启用前保持在 MATCHES_FUTURE 中（构建时以注释输出），
 * 避免在没有适配器的情况下往这些站点注入脚本。
 *
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
export const MATCHES_ACTIVE = [
  '// @match        *://*.bing.com/search*',
  '// @match        *://cn.bing.com/search*',
  '// @match        *://www4.bing.com/search*',
];

/** 待接入引擎的 @match 规则，启用时移到 MATCHES_ACTIVE */
export const MATCHES_FUTURE = [
  '// @match        *://www.google.com/search*',
  '// @match        *://www.google.com.hk/search*',
  '// @match        *://www.baidu.com/s*',
];

/** 本地开发服务地址，需与 scripts/serve.mjs 的端口一致 */
export const DEV_SERVER = 'http://127.0.0.1:8777';

export const META = {
  namespace: 'https://github.com/alt021/search-enhance',
  homepage: 'https://github.com/alt021/search-enhance',
  supportURL: 'https://github.com/alt021/search-enhance/issues',
  /** 正式发布地址（推到 GitHub 后生效） */
  downloadURL:
    'https://raw.githubusercontent.com/alt021/search-enhance/main/dist/search-enhance.user.js',
  icon: 'https://www.bing.com/sa/simg/bing_p_rr_teal_min.ico',
  runAt: 'document-start',
  noframes: true,
} as const;

export interface MetaOptions {
  version: string;
  description: string;
  /**
   * 开发模式：把 @updateURL / @downloadURL 指向本机服务。
   * 这样 Tampermonkey 装上后能自动跟随本地重建，且不会去请求尚未存在的 GitHub 地址。
   */
  dev?: boolean;
}

/** 生成注入到产物顶部的 UserScript 头部 */
export function buildMetaBlock(pkg: MetaOptions): string {
  // 开发版附加 -dev 后缀，便于与正式版区分并触发 Tampermonkey 更新
  const version = pkg.dev ? `${pkg.version}-dev` : pkg.version;

  return [
    '// ==UserScript==',
    `// @name         Search Enhance${pkg.dev ? ' (Dev)' : ''}`,
    '// @name:zh-CN   搜索体验增强' + (pkg.dev ? '（开发版）' : ''),
    `// @version      ${version}`,
    `// @description  ${pkg.description}`,
    '// @author       AmeXE2',
    `// @namespace    ${META.namespace}`,
    `// @homepageURL  ${META.homepage}`,
    `// @supportURL   ${META.supportURL}`,
    // 开发模式下以本机服务为准，避免 Tampermonkey 校验 404 的远端地址
    `// @downloadURL  ${pkg.dev ? `${DEV_SERVER}/search-enhance.user.js` : META.downloadURL}`,
    ...(pkg.dev
      ? [`// @updateURL    ${DEV_SERVER}/search-enhance.user.js`]
      : [`// @updateURL    ${META.downloadURL}`]),
    `// @icon         ${META.icon}`,
    ...MATCHES_ACTIVE,
    ...GRANTS.map((g) => `// @grant        ${g}`),
    `// @run-at       ${META.runAt}`,
    ...(META.noframes ? ['// @noframes'] : []),
    '// ==/UserScript==',
    '',
  ].join('\n');
}

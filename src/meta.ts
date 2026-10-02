/**
 * 单一元信息来源（source of truth）
 *
 * 这个文件会被 `scripts/build.mjs` 单独打包并导入，
 * 用来生成 UserScript 的 `// ==UserScript==` 头部。
 * 因此：只能有纯数据导出，不要 import 任何带副作用的模块。
 */

/** 引擎标识。新增引擎时同步扩展此列表，types/engine.ts 会据此推导类型。 */
export const ENGINE_IDS = ['bing', 'google', 'baidu'] as const;

/** 注入页面的脚本权限 */
export const GRANTS = [
  'GM_getValue',
  'GM_setValue',
  'GM_addStyle',
  'GM_registerMenuCommand',
  'GM_openInTab',
] as const;

/**
 * @match 规则 —— 已接入适配器的引擎。
 * Google / 百度未启用前保持在 MATCHES_FUTURE 中（构建时以注释输出），
 * 避免在没有适配器的情况下往这些站点注入脚本。
 */
export const MATCHES_ACTIVE = [
  '// @match        *://*.bing.com/search*',
  '// @match        *://cn.bing.com/search*',
];

/** 待接入引擎的 @match 规则，启用时移到 MATCHES_ACTIVE */
export const MATCHES_FUTURE = [
  '// @match        *://www.google.com/search*',
  '// @match        *://www.google.com.hk/search*',
  '// @match        *://www.baidu.com/s*',
];

export const META = {
  namespace: 'https://github.com/alt021/search-enhance',
  homepage: 'https://github.com/alt021/search-enhance',
  supportURL: 'https://github.com/alt021/search-enhance/issues',
  downloadURL:
    'https://raw.githubusercontent.com/alt021/search-enhance/main/dist/search-enhance.user.js',
  icon: 'https://www.bing.com/sa/simg/bing_p_rr_teal_min.ico',
  runAt: 'document-start',
  noframes: true,
} as const;

/** 生成注入到产物顶部的 UserScript 头部 */
export function buildMetaBlock(pkg: { version: string; description: string }): string {
  return [
    '// ==UserScript==',
    '// @name         Search Enhance',
    '// @name:zh-CN   搜索体验增强',
    `// @version      ${pkg.version}`,
    `// @description  ${pkg.description}`,
    '// @author       AmeXE2',
    `// @namespace    ${META.namespace}`,
    `// @homepageURL  ${META.homepage}`,
    `// @supportURL   ${META.supportURL}`,
    `// @downloadURL  ${META.downloadURL}`,
    `// @icon         ${META.icon}`,
    ...MATCHES_ACTIVE,
    ...GRANTS.map((g) => `// @grant        ${g}`),
    `// @run-at       ${META.runAt}`,
    ...(META.noframes ? ['// @noframes'] : []),
    '// ==/UserScript==',
    '',
  ].join('\n');
}

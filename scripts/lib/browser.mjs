/**
 * 测试用浏览器：全项目统一指向本机 Chromite。
 *
 * 为什么单独抽一个模块：浏览器路径与启动方式原先散落在 4 个脚本里，
 * 迁移或升级浏览器时要改多处、且容易漏改。收敛到这里后，
 * 「测试跑在哪个浏览器」在代码里只有一个出处。
 *
 * 关于 Chromite：
 *   它是 Chromium 分支（本机版本 153.0.8010.37），协议与 Chromium 一致，
 *   因此可直接用 playwright-core 的 chromium 通道驱动 —— 只是把
 *   executablePath 指向它，而不是 Playwright 自带的浏览器二进制
 *   （后者不在本机，沙箱内也无法下载）。
 *
 * 运行这些脚本需要在沙箱外（浏览器进程无法在沙箱内启动）。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 本模块位于 <root>/scripts/lib/，上溯三层即项目根 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 本机 Chromite 浏览器可执行文件 */
export const CHROMITE = 'C:/Users/AmeXE2/Documents/Programs/Chromite/chrome.exe';

/**
 * 实时测试共用的持久化配置目录。
 *
 * 全项目共用一个：Cookie 只攒一次，各脚本都不会再被 Bing
 * 当作首次访问而重定向（详见 launchChromitePersistent 的说明）。
 * 它位于 .build/ 下，已被 .gitignore 忽略。
 */
export const PROFILE_DIR = join(root, '.build', 'chromite-profile');

/** 驱动用的客户端库（在隔离的 Node 工作区内，不污染本仓库的依赖） */
const PLAYWRIGHT = 'C:/Users/AmeXE2/.workbuddy/binaries/node/workspace/node_modules/playwright-core';

/**
 * 确认 Chromite 存在。
 * 提前报错并给出可操作的提示，好过后面冒出一堆与浏览器无关的诡异失败。
 */
export function assertChromite() {
  if (existsSync(CHROMITE)) return;
  console.error(`找不到 Chromite 浏览器：${CHROMITE}`);
  console.error('测试统一在本机 Chromite 中进行。');
  console.error('若浏览器已迁移或升级，请更新 scripts/lib/browser.mjs 中的 CHROMITE。');
  process.exit(2);
}

/**
 * 启动 Chromite。
 * @param {object} [options] 透传给 playwright 的 launch 选项
 */
export async function launchChromite(options = {}) {
  assertChromite();
  const { chromium } = require(PLAYWRIGHT);
  return chromium.launch({ executablePath: CHROMITE, ...options });
}

/**
 * 以**持久化配置目录**启动 Chromite，返回 BrowserContext。
 *
 * 为什么实时测试要用它：默认的临时 profile 每次都是「全新访客」，
 * 而 Bing 对首次访问（无 Cookie）会做一次带 `rdr=1&rdrig=…` 的重定向，
 * 把已经重写好的 DOM 整个冲掉，随后脚本要在新文档上再跑一遍。
 * 持久化 profile 保留 Cookie 后，后续运行即表现为回访用户，
 * 与真实使用场景一致，也免去每轮多余的二次加载。
 *
 * 注意：持久 profile 意味着测试之间会残留状态（Cookie、缓存）。
 * 这是**有意为之** —— 测的就是真实用户的浏览器状态。
 * 需要干净的初次访问时，删除该目录即可。
 *
 * @param {string} userDataDir 配置目录（建议用 PROFILE_DIR）
 * @param {object} [options] 透传给 playwright 的选项
 */
export async function launchChromitePersistent(userDataDir, options = {}) {
  assertChromite();
  const { mkdirSync } = require('node:fs');
  mkdirSync(userDataDir, { recursive: true });
  const { chromium } = require(PLAYWRIGHT);
  return chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROMITE,
    ...options,
  });
}

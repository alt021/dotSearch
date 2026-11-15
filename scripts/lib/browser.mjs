/**
 * 测试用浏览器：全项目统一指向本机 Obscura。
 *
 * 为什么单独抽一个模块：浏览器路径与启动方式原先散落在多个脚本里，
 * 迁移或升级浏览器时要改多处、且容易漏改。收敛到这里后，
 * 「测试跑在哪个浏览器」在代码里只有一个出处。
 *
 * 关于 Obscura：
 *   它是无头浏览器，通过 `obscura serve` 暴露 Chrome DevTools Protocol，
 *   因此可以用 playwright-core 的 `chromium.connectOverCDP()` 驱动。
 *   与旧的 executablePath 方式不同，这里启动的是一个**服务进程**，
 *   脚本结束时必须把它连同子进程一起关掉。
 *
 * 常用参数：
 *   --allow-private-network  允许访问 127.0.0.1 上的本地验证页
 *   --proxy                  走本机代理（默认 127.0.0.1:7890，可用 SE_PROXY 覆盖）
 *   --storage-dir            持久化 Cookie / 缓存（实时验证用）
 *   --stealth                反指纹模式（部分站点需要）
 *
 * 运行这些脚本需要在沙箱外（浏览器进程无法在沙箱内启动）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 本模块位于 <root>/scripts/lib/，上溯三层即项目根 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 本机 Obscura 可执行文件 */
export const OBSCURA = 'C:/Users/AmeXE2/Documents/Programs/Tools/Obscura/obscura.exe';

/** 实时测试共用的持久化配置目录（Obscura --storage-dir） */
export const PROFILE_DIR = join(root, '.build', 'obscura-profile');

/** 本机代理地址；系统代理实测为 7890，可用环境变量覆盖 */
export const DEFAULT_PROXY = process.env.SE_PROXY || 'http://127.0.0.1:7890';

/**
 * Obscura 0.2.x 的能力边界（实测）。
 *
 * 它是轻量无头浏览器，DOM 与网络行为可用，但 CSS 状态与表单控件的
 * 部分实现不完整：
 *   - 不产生新标签页：window.open() 返回 null，target=_blank 不新建 Page
 *   - :focus / :hover 的 CSS 匹配不可靠（activeElement 正确，但样式不生效）
 *   - getComputedStyle().userSelect 返回空串
 *   - border 简写里的 var() 不作用到 input/select 等表单控件
 * 验证脚本据此跳过对应断言，避免把浏览器限制误报成产品故障。
 */
export const OBSCURA_SUPPORTS = Object.freeze({
  newTabs: false,
  focusState: false,
  hoverState: false,
  userSelect: false,
  formControlBorders: false,
});

export const NEW_TABS_SUPPORTED = OBSCURA_SUPPORTS.newTabs;

/** 驱动用的客户端库（在隔离的 Node 工作区内，不污染本仓库的依赖） */
const PLAYWRIGHT = 'C:/Users/AmeXE2/.workbuddy/binaries/node/workspace/node_modules/playwright-core';

/** 已启动的 Obscura 服务进程；进程退出时兜底清理 */
const children = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* 进程已退出 */
      }
    }
  });
}

/**
 * 确认 Obscura 存在。
 * 提前报错并给出可操作的提示，好过后面冒出一堆与浏览器无关的诡异失败。
 */
export function assertObscura() {
  if (existsSync(OBSCURA)) return;
  console.error(`找不到 Obscura：${OBSCURA}`);
  console.error('测试统一在本机 Obscura 中进行。');
  console.error('若浏览器已迁移或升级，请更新 scripts/lib/browser.mjs 中的 OBSCURA。');
  process.exit(2);
}

/** 取一个空闲的本机端口 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function proxyToString(proxy) {
  if (!proxy) return null;
  if (typeof proxy === 'string') return proxy;
  if (!proxy.server) return null;
  let value = String(proxy.server);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

function buildArgs(port, options) {
  const args = ['serve', '-p', String(port)];

  if (options.allowPrivateNetwork !== false) args.push('--allow-private-network');
  if (options.quiet !== false) args.push('--quiet');
  if (options.stealth) args.push('--stealth');
  if (options.userAgent) args.push('--user-agent', String(options.userAgent));
  if (options.storageDir) args.push('--storage-dir', String(options.storageDir));
  if (options.workers) args.push('--workers', String(options.workers));

  const proxy = proxyToString(options.proxy);
  if (proxy) args.push('--proxy', proxy);

  return args;
}

/**
 * 启动 Obscura 服务并连上 CDP。
 * @param {object} [options]
 * @param {object|string} [options.proxy]  代理，如 { server: 'http://127.0.0.1:7890' }
 * @param {string} [options.userAgent]
 * @param {string} [options.storageDir]
 * @param {boolean} [options.stealth]
 * @param {boolean} [options.allowPrivateNetwork] 默认 true
 * @param {number} [options.timeout] 等待 CDP 就绪的毫秒数
 */
async function startObscura(options = {}) {
  assertObscura();
  installExitHook();

  const port = await freePort();
  const args = buildArgs(port, options);
  const logs = [];

  const proc = spawn(OBSCURA, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(proc);

  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      logs.push(line);
      if (logs.length > 40) logs.shift();
    }
  };
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);

  let exitCode = null;
  proc.once('exit', (code) => {
    exitCode = code;
    children.delete(proc);
  });

  const timeout = options.timeout ?? 20_000;
  const deadline = Date.now() + timeout;
  const endpoint = `http://127.0.0.1:${port}`;

  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(
        `Obscura 启动失败（退出码 ${exitCode}）\n${logs.slice(-12).join('\n')}`,
      );
    }
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) break;
    } catch {
      /* 服务还没监听 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (Date.now() >= deadline) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(`等待 Obscura CDP 就绪超时（${timeout}ms）\n${logs.slice(-12).join('\n')}`);
  }

  const { chromium } = require(PLAYWRIGHT);
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(`连接 Obscura CDP 失败：${err?.message ?? err}\n${logs.slice(-12).join('\n')}`);
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };

  const originalClose = browser.close.bind(browser);
  browser.close = async () => {
    try {
      await originalClose().catch(() => {});
    } finally {
      stop();
    }
  };
  browser.on('disconnected', stop);

  return { browser, port, stop, originalClose };
}

/**
 * 启动 Obscura 并返回 Browser（新开页面用 browser.newPage）。
 * @param {object} [options] 见 startObscura
 */
export async function launchObscura(options = {}) {
  const { browser } = await startObscura(options);
  return browser;
}

/**
 * 以**持久化配置目录**启动 Obscura，返回 BrowserContext。
 *
 * Obscura 的 `--storage-dir` 相当于持久化 profile：实时测试需要保留 Cookie，
 * 否则 Bing 会把每轮都当首次访问、做一次 `rdr=1` 重定向，
 * 把已经重写好的 DOM 冲掉。
 *
 * 注意：持久 profile 意味着测试之间会残留状态（Cookie、缓存）。
 * 这是**有意为之** —— 测的就是真实用户的浏览器状态。
 * 需要干净的初次访问时，删除该目录即可。
 *
 * @param {string} userDataDir 配置目录（建议用 PROFILE_DIR）
 * @param {object} [options] 见 startObscura，另支持 locale / viewport / colorScheme
 */
export async function launchObscuraPersistent(userDataDir, options = {}) {
  mkdirSync(userDataDir, { recursive: true });

  const { browser, stop, originalClose } = await startObscura({
    ...options,
    storageDir: options.storageDir ?? userDataDir,
  });

  const context = browser.contexts()[0] ?? (await browser.newContext());
  await applyContextOptions(context, options);

  const originalContextClose = context.close.bind(context);
  context.close = async () => {
    try {
      await originalContextClose().catch((err) => {
        // 默认 context 关闭会连带关掉浏览器，之后再次 close 可能报“已关闭”
        if (!/closed|disconnected|target/i.test(String(err?.message ?? err))) throw err;
      });
    } finally {
      try {
        await originalClose().catch(() => {});
      } catch {
        /* ignore */
      }
      stop();
    }
  };

  return context;
}

/** 把 playwright 的 locale / viewport / colorScheme 应用到已有与后续页面 */
async function applyContextOptions(context, options) {
  const { locale, viewport, colorScheme } = options;

  if (locale) {
    const language = String(locale);
    const base = language.split('-')[0];
    await context
      .setExtraHTTPHeaders({ 'Accept-Language': `${language},${base};q=0.9` })
      .catch(() => {});
    await context
      .addInitScript({
        content: `Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(
          language,
        )} }); Object.defineProperty(navigator, 'languages', { get: () => [${JSON.stringify(
          language,
        )}] });`,
      })
      .catch(() => {});
  }

  const apply = async (page) => {
    if (viewport) await page.setViewportSize(viewport).catch(() => {});
    if (colorScheme) await page.emulateMedia({ colorScheme }).catch(() => {});
  };

  for (const page of context.pages()) await apply(page);
  context.on('page', (page) => {
    void apply(page);
  });
}

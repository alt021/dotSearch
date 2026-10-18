#!/usr/bin/env node
/**
 * 构建脚本：把 src/ 打包成可安装的 dist/*.user.js
 *
 *   node scripts/build.mjs                   正式构建（默认引擎：必应）
 *   node scripts/build.mjs --engine=bing     同上，显式指定引擎
 *   node scripts/build.mjs --engine=all      为全部已启用引擎各出一份
 *   node scripts/build.mjs --watch           监听重建
 *   node scripts/build.mjs --dev             开发构建（@updateURL 指向本机服务）
 *   node scripts/build.mjs --minify          压缩输出
 *
 * ## 多产物拆分
 *
 * 每个引擎产出**独立脚本**（dotSearch-bing.user.js / dotSearch-google.user.js …）：
 * 脚本体名不同（dotSearch for Bing），@match 不同，因此可以同时安装、
 * 互不覆盖。共享的 core / types / 通用 features 来自同一份源码，
 * 差异只在构建期常量 __SE_TARGET_ENGINE__。
 *
 * 开发构建输出到 dist/dev/，避免与正式产物混在一起，
 * 便于 Tampermonkey 同时保留「正式版」和「开发版」两个脚本。
 *
 * 产物文件名取自 src/meta.ts 的 artifactFor() —— 同一份常量也用于
 * 头部里的安装地址，两处不会不一致。
 */
import * as esbuild from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const dev = process.argv.includes('--dev');

/** --engine=<id> | --engine=all，缺省为 meta.ts 的 DEFAULT_ENGINE */
const engineArg = process.argv.find((a) => a.startsWith('--engine='))?.split('=')[1];

const LOG = '[dotSearch]';

/**
 * 动态读取 src/meta.ts 里的头部生成函数。
 * 单独编译到临时文件后 import，避免在 build.mjs 里重复维护元信息。
 */
async function loadMeta() {
  const tmpDir = join(root, '.build');
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, 'meta.mjs');

  await esbuild.build({
    entryPoints: [join(root, 'src', 'meta.ts')],
    outfile: tmpFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });

  return import(pathToFileURL(tmpFile).href);
}

const meta = await loadMeta();

/* 解析本次要构建的引擎列表 */
const ALL = Object.keys(meta.ENGINE_BUILDS);
const engines =
  !engineArg || engineArg === 'all' ? (engineArg === 'all' ? ALL : [meta.DEFAULT_ENGINE]) : [engineArg];

for (const id of engines) {
  if (!meta.ENGINE_BUILDS[id]) {
    console.error(`${LOG} 未知引擎：${id}（可选：${ALL.join(' / ')} / all）`);
    process.exit(1);
  }
}

const outDir = dev ? join(root, 'dist', 'dev') : join(root, 'dist');
await mkdir(outDir, { recursive: true });

/** 单个引擎的构建配置 */
function optionsFor(engineId) {
  const banner = meta.buildMetaBlock({
    version: pkg.version,
    description: pkg.description,
    engine: engineId,
    dev,
  });
  const outFile = join(outDir, meta.artifactFor(engineId));

  /** @type {import('esbuild').BuildOptions} */
  return {
    entryPoints: [join(root, 'src', 'index.ts')],
    outfile: outFile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100', 'firefox100', 'edge100', 'safari15'],
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'info',
    minify,
    sourcemap: watch ? 'inline' : false,
    banner: { js: banner },
    loader: { '.css': 'text' },
    /*
     * 目标引擎以构建期常量的形式注入。
     * 这样每个产物只激活自己的适配器，多引擎同时安装也不会互相抢页面。
     */
    define: { __SE_TARGET_ENGINE__: JSON.stringify(engineId) },
  };
}

if (watch) {
  for (const engineId of engines) {
    const opts = optionsFor(engineId);
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    const rel = opts.outfile.slice(root.length + 1).replace(/\\/g, '/');
    console.log(`${LOG} 监听中（${engineId}），src/ 变更将自动重建 ${rel}`);
  }
  if (dev) {
    console.log(`${LOG} 开发模式：Tampermonkey 安装地址 http://127.0.0.1:8777/<产物名>`);
    console.log(`${LOG} 请另开一个终端运行 npm run serve`);
  }
} else {
  for (const engineId of engines) {
    const opts = optionsFor(engineId);
    const result = await esbuild.build({ ...opts, metafile: true });
    const relOut = opts.outfile.slice(root.length + 1).replace(/\\/g, '/');
    const entry = result.metafile.outputs[relOut] ?? Object.values(result.metafile.outputs)[0];
    if (entry) {
      const name = meta.ENGINE_BUILDS[engineId].displayName;
      console.log(`${LOG} ${name}：${relOut}  ${(entry.bytes / 1024).toFixed(1)} KB`);
    }
  }
}

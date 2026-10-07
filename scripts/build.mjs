#!/usr/bin/env node
/**
 * 构建脚本：把 src/ 打包成单个可安装的 dist/*.user.js
 *
 *   node scripts/build.mjs              正式构建
 *   node scripts/build.mjs --watch      监听重建
 *   node scripts/build.mjs --dev        开发构建（@updateURL 指向本机服务）
 *   node scripts/build.mjs --minify     压缩输出
 *
 * 开发构建会输出到 dist/dev/，避免与正式产物混在一起，
 * 便于 Tampermonkey 同时保留「正式版」和「开发版」两个脚本。
 *
 * 产物文件名取自 src/meta.ts 的 ARTIFACT —— 同一份常量也用于
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
const banner = meta.buildMetaBlock({
  version: pkg.version,
  description: pkg.description,
  dev,
});

const outDir = dev ? join(root, 'dist', 'dev') : join(root, 'dist');
const outFile = join(outDir, meta.ARTIFACT);

/** @type {import('esbuild').BuildOptions} */
const options = {
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
};

await mkdir(outDir, { recursive: true });

const relOut = outFile.slice(root.length + 1).replace(/\\/g, '/');

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`${LOG} 监听中，src/ 变更将自动重建 ${relOut}`);
  if (dev) {
    console.log(`${LOG} 开发模式：Tampermonkey 安装地址为 http://127.0.0.1:8777/${meta.ARTIFACT}`);
    console.log(`${LOG} 请另开一个终端运行 npm run serve`);
  }
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const entry = result.metafile.outputs[relOut] ?? Object.values(result.metafile.outputs)[0];
  if (entry) {
    console.log(`${LOG} 构建完成：${relOut}  ${(entry.bytes / 1024).toFixed(1)} KB`);
  }
}

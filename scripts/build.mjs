#!/usr/bin/env node
/**
 * 构建脚本：把 src/ 打包成单个可安装的 dist/search-enhance.user.js
 *
 *   node scripts/build.mjs            构建
 *   node scripts/build.mjs --watch    监听重建
 *   node scripts/build.mjs --minify   压缩输出
 */
import * as esbuild from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/**
 * 动态读取 src/meta.ts 里的头部生成函数。
 * 单独编译到临时文件后 import，避免在 build.mjs 里重复维护元信息。
 */
async function loadMetaBlock() {
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

  const mod = await import(pathToFileURL(tmpFile).href);
  return mod.buildMetaBlock({ name: pkg.name, version: pkg.version, description: pkg.description });
}

const banner = await loadMetaBlock();

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'dist', 'search-enhance.user.js'),
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
  define: {
    __SCRIPT_VERSION__: JSON.stringify(pkg.version),
  },
};

await mkdir(join(root, 'dist'), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[search-enhance] 监听中，src/ 变更将自动重建 dist/search-enhance.user.js');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const out = result.metafile.outputs[`dist/${pkg.name}.user.js`] ?? Object.values(result.metafile.outputs)[0];
  if (out) {
    console.log(`[search-enhance] 构建完成：dist/${pkg.name}.user.js  ${(out.bytes / 1024).toFixed(1)} KB`);
  }
}

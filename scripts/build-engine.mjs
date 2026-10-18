#!/usr/bin/env node
/**
 * 直接构建入口（Node API 版）。
 *
 * 与 scripts/build.mjs 的区别：
 *   build.mjs      面向日常开发，带 --watch / --dev / --minify
 *   本脚本          面向「一次把指定引擎全构建出来」，参数更直接：
 *
 *     node scripts/build-engine.mjs bing
 *     node scripts/build-engine.mjs bing google --dev
 *     node scripts/build-engine.mjs all
 *
 * 为什么需要它：build.mjs 用 --engine=<id> 传递，在部分 shell 里
 * 引号会被吞掉（实测 PowerShell 下 "bing" 会变成裸标识符 bing）。
 * 本脚本用位置参数，不经过 shell 的引号解析，更稳。
 */
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** meta.ts 先单独编译，再导入 —— 与 build.mjs 同一套做法 */
const metaTmp = join(root, '.build', 'meta.mjs');
await mkdir(join(root, '.build'), { recursive: true });
await esbuild.build({
  entryPoints: [join(root, 'src', 'meta.ts')],
  outfile: metaTmp,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const meta = await import(`${pathToFileURL(metaTmp).href}?t=${Date.now()}`);

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const requested = args.filter((a) => !a.startsWith('--'));
const engineIds =
  requested.length === 0
    ? [meta.DEFAULT_ENGINE]
    : requested.includes('all')
      ? Object.keys(meta.ENGINE_BUILDS)
      : requested;

for (const id of engineIds) {
  if (!meta.ENGINE_BUILDS[id]) {
    console.error(`未知引擎：${id}（可选：${Object.keys(meta.ENGINE_BUILDS).join(' / ')} / all）`);
    process.exit(1);
  }
}

const outDir = dev ? join(root, 'dist', 'dev') : join(root, 'dist');
await mkdir(outDir, { recursive: true });

for (const engine of engineIds) {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src', 'index.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100', 'firefox100', 'edge100', 'safari15'],
    charset: 'utf8',
    legalComments: 'none',
    loader: { '.css': 'text' },
    define: { __SE_TARGET_ENGINE__: JSON.stringify(engine) },
    logLevel: 'silent',
  });

  const js = result.outputFiles[0].text;
  const banner = meta.buildMetaBlock({
    version: pkg.version,
    description: pkg.description,
    engine,
    dev,
  });

  const outFile = join(outDir, meta.artifactFor(engine));
  await writeFile(outFile, banner + js, 'utf8');

  const ok = js.includes(`targetId = ${JSON.stringify(engine)}`);
  console.log(
    `[dotSearch] ${meta.ENGINE_BUILDS[engine].displayName}：` +
      `${outFile.slice(root.length + 1).replace(/\\/g, '/')}  ` +
      `${(Buffer.byteLength(banner + js) / 1024).toFixed(1)} KB`,
  );
  if (!ok) console.warn('[dotSearch] 警告：目标引擎常量未正确注入，产物可能不工作');
}

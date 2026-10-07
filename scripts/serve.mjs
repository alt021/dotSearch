#!/usr/bin/env node
/**
 * 本地静态服务：把构建产物暴露给浏览器，供 Tampermonkey 以 URL 方式安装。
 *
 *   npm run serve              服务 dist/dev（需先 npm run build:dev）
 *   npm run serve -- --dir dist  服务正式产物目录
 *   npm run serve -- --port 9000
 *
 * 配合开发构建使用：产物头部带 @updateURL 指向本服务，
 * Tampermonkey 打开 URL 安装后能自动跟随本地重建。
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, basename } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(argValue('--port', '8777'));
/** 默认服务开发产物目录，这样 URL 与头部 @updateURL 一致 */
const serveDir = join(root, argValue('--dir', 'dist/dev'));

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'Access-Control-Allow-Origin': '*', ...headers });
    res.end(body);
  };

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');

    // 根路径列出目录内容，便于确认服务是否正常
    if (rel === '' || rel === '.') {
      const files = await readdir(serveDir).catch(() => []);
      const list = files
        .map((f) => `<li><a href="/${encodeURIComponent(f)}">${f}</a></li>`)
        .join('');
      send(200, `<h2>${basename(serveDir)}/</h2><ul>${list || '<li>（空，请先运行 npm run build:dev）</li>'}</ul>`);
      return;
    }

    const filePath = join(serveDir, rel);
    // 目录穿越防护：解析后必须仍在 serveDir 内
    if (!normalize(filePath).startsWith(normalize(serveDir))) {
      send(403, '403 Forbidden');
      return;
    }

    const info = await stat(filePath);
    if (!info.isFile()) {
      send(404, '404 Not Found');
      return;
    }

    const body = await readFile(filePath);
    send(200, body, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      // 开发期禁用缓存，保证重建后刷新即拿到新代码
      'Cache-Control': 'no-store, must-revalidate',
    });
  } catch {
    send(404, '404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const rel = serveDir.slice(root.length + 1).replace(/\\/g, '/');
  console.log(`[serve] 目录：${rel}`);
  /*
   * 列出目录里真实的 .user.js，而不是把文件名写死在日志里。
   * 产物名改过一次（search-enhance → dotSearch），写死就会照旧印出一个
   * 404 的安装地址 —— 而且只有用户点了才会发现。
   */
  let bundles = [];
  try {
    bundles = (await readdir(serveDir)).filter((f) => f.endsWith('.user.js'));
  } catch {
    /* 目录尚不存在（还没构建过） */
  }
  if (bundles.length === 0) {
    console.log('[serve] 该目录下暂无 .user.js，请先运行 npm run build:dev');
  } else {
    for (const f of bundles) console.log(`[serve] 安装地址：http://127.0.0.1:${PORT}/${f}`);
  }
  console.log('[serve] 在 Tampermonkey 中打开该 URL 即可安装。按 Ctrl+C 停止。');
});

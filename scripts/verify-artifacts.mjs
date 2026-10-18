/**
 * 产物结构校验：确认拆分后的每个引擎产物都自洽。
 * 检查项见下方 checks 数组。用法：node scripts/verify-artifacts.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const meta = await import(`${pathToFileURL(join(root, '.build', 'meta.mjs')).href}?t=${Date.now()}`);

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const engines = targets.length > 0 ? targets : ['bing'];

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

for (const engine of engines) {
  const build = meta.ENGINE_BUILDS[engine];
  const artifact = meta.artifactFor(engine);
  const file = join(root, 'dist', artifact);

  console.log(`\n=== ${build.displayName} (${artifact}) ===`);

  if (!existsSync(file)) {
    check('产物存在', false, file);
    continue;
  }
  const src = await readFile(file, 'utf8');

  check('脚本体名为「' + build.displayName + '」', src.includes(`// @name         ${build.displayName}\n`));
  check('目标引擎常量已注入', src.includes(`targetId = ${JSON.stringify(engine)}`));
  check(
    '只带了本引擎的 @match',
    build.matches.every((m) => src.includes(m)) &&
      !/google\.com\/search/.test(src.split('==/UserScript==')[0].replace(build.matches.join('\n'), '')),
  );
  check('头部闭合', src.includes('// ==/UserScript=='));
  /*
   * 权限面：只需样式 + 脚本级存储。
   * GM_cookie 已随 Cookie 清理能力一并撤销 —— 这里反向断言，
   * 防止它被无意中加回来（那会让安装时多出一条敏感的授权提示）。
   */
  check(
    '权限仅样式与存储（无 GM_cookie）',
    /@grant\s+GM_addStyle/.test(src) &&
      /@grant\s+GM_getValue/.test(src) &&
      /@grant\s+GM_setValue/.test(src) &&
      !/@grant\s+GM_cookie/.test(src),
  );
  check('正式地址指向本产物', src.includes(`dist/${artifact}`));
  check('未混入其它引擎的适配器', !new RegExp(`id: "(?!${engine})`).test(src.split('var activeEngines')[1]?.slice(0, 300) ?? ''));
}

console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

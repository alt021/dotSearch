/**
 * 发行版发布前核验（release gate）。
 *
 * 与 verify-artifacts 的区别：
 *   verify-artifacts  检查产物「结构正确」（头部、注入、@match）
 *   本脚本            检查产物「功能完整」—— 每个已实现的能力都能在包里找到
 *
 * 用法：node scripts/verify-release.mjs [engine]
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = process.argv[2] ?? 'bing';
const meta = await import(`${pathToFileURL(join(root, '.build', 'meta.mjs')).href}?t=${Date.now()}`);

const artifact = meta.artifactFor(engine);
const file = join(root, 'dist', artifact);

if (!existsSync(file)) {
  console.error(`找不到产物：${file}`);
  process.exit(2);
}

const src = readFileSync(file, 'utf8');
const head = src.slice(0, src.indexOf('==/UserScript=='));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log(`=== 发布核验：${artifact} ===`);

/* ---- 版本与元信息 ---- */
check('版本与 package.json 一致', head.includes(`@version      ${pkg.version}`), pkg.version);
check('非开发版（名称无 Dev 后缀）', !/\(Dev\)/.test(head));
check('更新地址为正式地址', /raw\.githubusercontent\.com/.test(head) && !/127\.0\.0\.1/.test(head));
check('未残留本地服务地址', !src.includes('127.0.0.1:8777'));

/* ---- 权限 ---- */
const grants = [...head.matchAll(/@grant\s+(\S+)/g)].map((m) => m[1]);
check(
  '权限集合与设计一致',
  grants.sort().join(',') === 'GM_addStyle,GM_getValue,GM_setValue',
  grants.join(','),
);

/*
 * Cookie 能力必须彻底移除。
 *
 * 这是「净化链接」改造的核心约束：不再有任何删除/写入 Cookie 的代码路径。
 * 反向断言比正向断言更重要 —— 正向只证明新功能在，反向才能证明旧能力真的没了。
 */
check('未申请 GM_cookie 权限', !grants.includes('GM_cookie'));
check('包内无 GM_cookie 调用', !/GM_cookie/.test(src));
check('包内无 Cookie 存档逻辑', !/cookie-backup/i.test(src));
check('包内无身份 Cookie 守卫', !/startIdentityGuard/.test(src));
check('页头不再有「隐私检索」标记', !/隐私检索/.test(src));
check('包内无 document.cookie 写入', !/document\.cookie\s*=/.test(src));

/* ---- 注入范围 ---- */
check('注入全部必应入口', /bing\.com\/search\*/.test(head));

/* ---- 功能完整性：每项能力都要在包内 ---- */
const features = [
  ['结果页重写', 'se-masthead'],
  ['结果条目结构', 'se-num'],
  ['分页重建', 'se-pagination'],
  ['分页化隐藏占位', 'se-item-hidden'],
  ['过滤：标签', 'se-tag'],
  ['过滤：浮层', 'se-filter-panel'],
  ['附加设置弹窗', 'se-settings-panel'],
  ['净化链接开关', 'se-privacy-toggle'],
  ['净化：URL 白名单', 'sanitizeSearchUrl'],
  ['净化：地址栏改写', 'cleanAddressBar'],
  ['永页机协同', 'pagetual'],
  ['深色模式', 'prefers-color-scheme'],
  ['账户会话采集', 'captureSession'],
  ['菜单入口', 'se-menu-popup'],
  // 设置页清理：折叠已被取代的设置项
  ['设置页识别', 'isSettingsPage'],
  ['待折叠设置清单', 'getSupersededSettings'],
  ['折叠 UI', 'se-setting-fold'],
];

/*
 * ---- 响应式：窄屏收紧两侧留白 + 内容顶格 + 分页只留前后页 ----
 * 这些规则被误删时，手机端会退回「两侧 32px 留白 + 内容右移 4.5rem +
 * 页码挤成几行」的旧形态，而单看桌面截图完全发现不了。
 */
check('窄屏 media query 存在', /@media\s*\(max-width:\s*600px\)/.test(src));
check('窄屏收紧水平留白', /padding-left:\s*0\.875rem/.test(src));
check('窄屏内容顶格（改单列）', /grid-template-columns:\s*1fr/.test(src));
check('上下页按钮存在', src.includes('se-page-step'));
check('页码列表容器存在', src.includes('se-pagination-pages'));
check('上下页容器存在', src.includes('se-pagination-steps'));
check('桌面默认隐藏上下页', /\.se-pagination-steps\s*\{[^}]*display:\s*none/.test(src));
for (const [label, needle] of features) {
  check(label, src.includes(needle));
}

/* ---- 界面文案（发布版本对用户可见，不能被误删） ---- */
check('净化说明文案', src.includes('去除链接中的跟踪条目，其余不再变动'));
check('过滤功能说明', src.includes('屏蔽指定网站的搜索结果'));
check('开关标签为净化链接', src.includes('净化链接'));

/* ---- 未启用的引擎不应混入 ---- */
check('未混入 Google 适配器', !src.includes('www.google.com/search'));
check('未混入百度适配器', !src.includes('www.baidu.com/s'));

/* ---- 文件本身 ---- */
const bytes = statSync(file).size;
const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(`\n  文件：${artifact}`);
console.log(`  大小：${(bytes / 1024).toFixed(1)} KB（${bytes} 字节）`);
console.log(`  SHA-256：${sha}`);

console.log(pass ? '\n✅ 可以发布' : '\n❌ 存在阻塞项');
process.exit(pass ? 0 : 1);

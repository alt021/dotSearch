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
check(
  '更新地址走 jsDelivr',
  head.includes('https://cdn.jsdelivr.net/gh/alt021/dotSearch@main') &&
    !/raw\.githubusercontent/.test(head) &&
    !/127\.0\.0\.1/.test(head),
);
check(
  '脚本图标走 jsDelivr',
  /\/\/ @icon\s+https:\/\/cdn\.jsdelivr\.net\/gh\/alt021\/dotSearch@main\/assets\/icon\//.test(
    head,
  ),
);
check('未残留本地服务地址', !src.includes('127.0.0.1:8777'));

/* ---- 权限 ---- */
const grants = [...head.matchAll(/@grant\s+(\S+)/g)].map((m) => m[1]);
check(
  '权限集合与设计一致',
  grants.sort().join(',') === 'GM_addStyle,GM_getValue,GM_setValue,unsafeWindow',
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
if (engine === 'bing') {
  check('注入全部必应入口', /bing\.com\/search\*/.test(head));
} else if (engine === 'google') {
  check(
    '注入 Google 地区域名',
    /google\.com\/search\*/.test(head) && /@include\s+\/\^https/.test(head),
  );
} else if (engine === 'baidu') {
  check(
    '注入百度搜索页',
    /baidu\.com\/s\*/.test(head) && head.includes('www.baidu.com/s*'),
  );
  check(
    '注入百度首页',
    /@include\s+\/\^https/.test(head) && head.includes('index\\.html'),
  );
}

/* ---- 功能完整性：每项能力都要在包内 ---- */
const features = [
  ['结果页重写', 'se-masthead'],
  ['结果条目结构', 'se-num'],
  ['加载更多按钮', 'se-more-button'],
  ['加载更多上限', 'MAX_TOTAL_RESULTS'],
  ['隐藏结果占位', 'se-item-hidden'],
  ['过滤：标签', 'se-tag'],
  ['过滤：浮层', 'se-filter-panel'],
  ['附加设置弹窗', 'se-settings-panel'],
  ['自动加载更多设置', 'se-auto-more-toggle'],
  ['净化链接开关', 'se-privacy-toggle'],
  ['净化：URL 白名单', 'sanitizeSearchUrl'],
  ['净化：地址栏改写', 'cleanAddressBar'],
  ['永页机停用', 'initedPagetual'],
  ['深色模式', 'prefers-color-scheme'],
  ['菜单入口', 'se-menu-popup'],
];

if (engine === 'bing') {
  features.push(
    ['账户会话采集', 'captureSession'],
    // 设置页清理：折叠已被取代的设置项
    ['设置页识别', 'isSettingsPage'],
    ['待折叠设置清单', 'getSupersededSettings'],
    ['折叠 UI', 'se-setting-fold'],
  );
} else if (engine === 'google') {
  features.push(
    ['Google 搜索设置入口', '/preferences'],
    ['Google 分页参数 start', 'param: "start"'],
  );
} else if (engine === 'baidu') {
  features.push(['百度分页参数 pn', 'param: "pn"']);
}

/*
 * ---- 拼页：按钮与自动加载，旧的页码栏必须彻底消失 ----
 * 页码栏是已废弃的能力，残留任何一条都会和「加载更多」抢翻页；
 * 按钮或自动加载开关丢失时，用户会以为只有 10 条结果。
 */
check('SHOW MORE 文案存在', src.includes('SHOW MORE'));
check('无旧页码栏', !src.includes('se-pagination'));
check('无旧页码标记', !/se-page-current|syncPagerPage/.test(src));
check('加载更多不产生分割线', !/\.se-more\s*\{[^}]*border-top/.test(src));
/*
 * ---- 移动端支持已移除（反向断言）----
 * 残留的窄屏规则或 PREV/NEXT 控件会让桌面版在窄窗口下换一套版式，
 * 属于已明确废弃的能力。
 */
check('无窄屏 media query', !/@media\s*\(max-width:\s*\d+px\)/.test(src));
check('无上下页控件', !src.includes('se-page-step'));
check('无上下页容器', !src.includes('se-pagination-steps'));
for (const [label, needle] of features) {
  check(label, src.includes(needle));
}

/* ---- 强调色：每个产物只带自己的品牌色 ---- */
const theme =
  engine === 'bing'
    ? {
        own: ['#008373', '#2ec4a6'],
        foreign: ['#4285f4', '#8ab4f8', '#e30613', '#ff2a34'],
      }
    : engine === 'google'
      ? {
          own: ['#4285f4', '#8ab4f8'],
          foreign: ['#008373', '#2ec4a6', '#e30613', '#ff2a34'],
        }
      : engine === 'baidu'
        ? {
            own: ['#2529d8', '#7d83ff'],
            foreign: ['#008373', '#2ec4a6', '#4285f4', '#8ab4f8', '#e30613', '#ff2a34'],
          }
        : null;
if (theme) {
  check(
    '强调色是本引擎品牌色',
    theme.own.every((color) => src.toLowerCase().includes(color)),
  );
  check(
    '未混入其它引擎强调色',
    theme.foreign.every((color) => !src.toLowerCase().includes(color)),
  );
}

/* ---- 界面文案（发布版本对用户可见，不能被误删） ---- */
check('净化说明文案', src.includes('去除链接中的跟踪条目，其余不再变动'));
check('过滤功能说明', src.includes('屏蔽指定网站的搜索结果'));
check('开关标签为净化链接', src.includes('净化链接'));
check('自动加载开关标签', src.includes('自动加载更多结果'));
check('自动加载说明文案', src.includes('每次检索最多加载 100 条结果'));

/* ---- 引擎隔离：不能把另一个引擎的专有入口带进来 ---- */
if (engine === 'google') {
  /*
   * 用户明确要求 Google 版不提供 Rewards、不做账号登录状态检测。
   * 这些反向断言比「有搜索设置」更重要 —— 它们证明必应专有逻辑没有混入。
   */
  check('不提供 Microsoft Rewards', !/rewards\.bing\.com|Microsoft Rewards/.test(src));
  check(
    '不含必应账户 / 登录判据',
    !/account\.microsoft\.com|readTopBarSession|#id_a|#id_l|#id_p/.test(src),
  );
  check(
    '不含必应设置页折叠',
    !/\.b_vPanel|#settings_suggestions|#newwnd|#newsnt/.test(src),
  );
  check('未混入百度适配器', !src.includes('www.baidu.com/s'));
} else if (engine === 'baidu') {
  check('未混入 Google 适配器', !src.includes('www.google.com/search'));
  check('未混入 Bing 适配器', !src.includes('www.bing.com/search'));
  check(
    '不含必应账户 / Rewards',
    !/rewards\.bing\.com|account\.microsoft\.com|readTopBarSession/.test(src),
  );
} else {
  check('未混入 Google 适配器', !src.includes('www.google.com/search'));
  check('未混入百度适配器', !src.includes('www.baidu.com/s'));
}

/* ---- 文件本身 ---- */
const bytes = statSync(file).size;
const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(`\n  文件：${artifact}`);
console.log(`  大小：${(bytes / 1024).toFixed(1)} KB（${bytes} 字节）`);
console.log(`  SHA-256：${sha}`);

console.log(pass ? '\n✅ 可以发布' : '\n❌ 存在阻塞项');
process.exit(pass ? 0 : 1);

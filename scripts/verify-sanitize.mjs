/**
 * 链接净化的单元验证（纯 Node，不需要浏览器）。
 *
 * 被测模块由外部构建产出（见 package.json 的 verify:sanitize），
 * 本脚本只负责导入与断言。
 *
 * 覆盖重点：
 *   1. 白名单净化——该丢的丢、该留的留
 *   2. 未知参数默认丢弃（白名单的安全方向）
 *   3. 非搜索场景不被破坏（分页基址、中文编码）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.build', 'privacy-unit.mjs');
if (!existsSync(out)) {
  console.error('缺少 .build/privacy-unit.mjs，请先运行构建（见 package.json 的 verify:sanitize）。');
  process.exit(2);
}

const { sanitizeSearchUrl } = await import(`file://${out.replace(/\\/g, '/')}`);

let pass = true;
const check = (label, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('=== URL 净化（白名单）===');

const cases = [
  {
    name: '剥掉会话与追踪参数',
    input: 'https://www.bing.com/search?q=hello&form=QBRE&cvid=ABC123&IG=dead&pq=prev&sp=-1',
    expect: 'https://www.bing.com/search?q=hello',
  },
  {
    name: '保留分页偏移 first',
    input: 'https://www.bing.com/search?q=hello&first=11&cvid=ABC',
    expect: 'https://www.bing.com/search?q=hello&first=11',
  },
  {
    name: '保留每页条数 count',
    input: 'https://cn.bing.com/search?q=%E4%B8%AD%E6%96%87&count=20&cvid=ZZZ',
    expect: 'https://cn.bing.com/search?q=%E4%B8%AD%E6%96%87&count=20',
  },
  {
    name: '未知参数默认丢弃（白名单的安全方向）',
    input: 'https://www.bing.com/search?q=test&future_tracker_id=xyz',
    expect: 'https://www.bing.com/search?q=test',
  },
  {
    name: '去掉 hash',
    input: 'https://www.bing.com/search?q=test&cvid=A#frag',
    expect: 'https://www.bing.com/search?q=test',
  },
  {
    name: '已干净的地址保持不变',
    input: 'https://www.bing.com/search?q=test',
    expect: 'https://www.bing.com/search?q=test',
  },
  {
    name: '中文与特殊字符正确编码',
    input: 'https://www.bing.com/search?q=%E6%90%9C%E7%B4%A2+%26+test&form=X',
    expect: 'https://www.bing.com/search?q=%E6%90%9C%E7%B4%A2+%26+test',
  },
  {
    name: '无搜索词时只留分页参数',
    input: 'https://www.bing.com/search?first=21&cvid=Y',
    expect: 'https://www.bing.com/search?first=21',
  },
];

for (const c of cases) {
  const got = sanitizeSearchUrl(new URL(c.input), 'q').href;
  check(c.name, got === c.expect, got === c.expect ? '' : `得到 ${got}`);
}

/* ---- 参数顺序：q 应在最前，便于阅读与复制 ---- */
const ordered = sanitizeSearchUrl(
  new URL('https://www.bing.com/search?cvid=X&first=11&q=hello'),
  'q',
).href;
check('搜索词排在分页参数之前', ordered === 'https://www.bing.com/search?q=hello&first=11', ordered);

/* ---- 幂等：净化两次结果一致 ---- */
const once = sanitizeSearchUrl(new URL('https://www.bing.com/search?q=a&cvid=1&first=11'), 'q');
const twice = sanitizeSearchUrl(once, 'q');
check('幂等（重复净化不改变结果）', once.href === twice.href);

/* ---- 不同引擎的搜索词参数 ---- */
const baidu = sanitizeSearchUrl(new URL('https://www.baidu.com/s?wd=test&rsv_spt=1'), 'wd').href;
check('百度 wd 参数被保留', baidu === 'https://www.baidu.com/s?wd=test', baidu);

/* ==========================================================================
 * 界面文案
 * --------------------------------------------------------------------------
 * 说明文字要被断言，是因为它是对用户的承诺。
 * 措辞被误改（例如又写成「不改变 Cookie」这种旧说法）会让用户
 * 对功能范围产生错误理解，因此单独立断言。
 * ========================================================================== */
console.log('\n=== 界面文案 ===');
const panelSrc = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings-panel.ts'),
  'utf8',
);
check('说明为「去除链接中的跟踪条目，其余不再变动。」', /去除链接中的跟踪条目，其余不再变动。/.test(panelSrc));
check('开关标签为「净化链接」', /label\.textContent = '净化链接'/.test(panelSrc));
check('过滤行写明「屏蔽指定网站的搜索结果」', /屏蔽指定网站的搜索结果/.test(panelSrc));

console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
process.exit(pass ? 0 : 1);

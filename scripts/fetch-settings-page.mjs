/**
 * 抓取 Bing 设置页（/account/general）的真实结构。
 *
 * 目的：在写「隐藏哪些设置项」之前，先看清页面到底有哪些分组与条目，
 * 而不是凭印象猜测。
 *
 * 用法：node scripts/fetch-settings-page.mjs
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChromite } from './lib/browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, '.build'), { recursive: true });

const browser = await launchChromite();
const page = await browser.newPage({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 1400 },
});

const targets = [
  { name: 'www', url: 'https://www.bing.com/account/general' },
  { name: 'cn', url: 'https://cn.bing.com/account/general' },
];

for (const t of targets) {
  console.log(`\n=== 抓取 ${t.name}: ${t.url} ===`);
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    const info = await page.evaluate(() => {
      // 找出所有可能的设置分组标题
      const headingTexts = [...document.querySelectorAll('h1, h2, h3, h4, legend')]
        .map((el) => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 80) ?? '',
          cls: String(el.className || '').slice(0, 60),
          id: el.id || '',
        }))
        .filter((h) => h.text);

      // 找出所有表单控件（开关 / 下拉 / 单选）
      const controls = [...document.querySelectorAll('input, select, button[role="switch"]')]
        .map((el) => {
          const label =
            el.closest('label')?.textContent?.trim() ??
            document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ??
            el.getAttribute('aria-label') ??
            '';
          return {
            tag: el.tagName,
            type: el.getAttribute('type') ?? '',
            id: el.id || '',
            name: el.getAttribute('name') ?? '',
            label: label.slice(0, 80),
          };
        })
        .filter((c) => c.label || c.id);

      // 主要容器
      const containers = [...document.querySelectorAll('[class*="setting"], [id*="setting"], [class*="pref"], [id*="pref"]')]
        .map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 70) }))
        .slice(0, 60);

      return {
        title: document.title,
        url: location.href,
        bodyLen: document.body?.innerHTML.length ?? 0,
        headingTexts,
        controls,
        containers,
      };
    });

    console.log(`  标题: ${info.title}`);
    console.log(`  实际 URL: ${info.url}`);
    console.log(`  body 长度: ${info.bodyLen}`);
    console.log(`\n  分组标题 (${info.headingTexts.length}):`);
    for (const h of info.headingTexts) {
      console.log(`    [${h.tag}] ${h.text}  (id=${h.id} cls=${h.cls})`);
    }
    console.log(`\n  表单控件 (${info.controls.length}):`);
    for (const c of info.controls) {
      console.log(`    <${c.tag}> type=${c.type} id=${c.id} name=${c.name}  「${c.label}」`);
    }
    console.log(`\n  相关容器 (${info.containers.length}):`);
    for (const c of info.containers.slice(0, 30)) {
      console.log(`    <${c.tag}> id=${c.id} cls=${c.cls}`);
    }

    const html = await page.content();
    writeFileSync(join(root, '.build', `bing-settings-${t.name}.html`), html, 'utf8');
    console.log(`\n  已保存 .build/bing-settings-${t.name}.html`);

    await page.screenshot({
      path: join(root, '.build', `bing-settings-${t.name}.png`),
      fullPage: true,
    });
    console.log(`  已保存 .build/bing-settings-${t.name}.png`);
  } catch (e) {
    console.log(`  抓取失败: ${e.message}`);
  }
}

await browser.close();

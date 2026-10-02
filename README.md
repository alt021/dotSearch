# Search Enhance

一个增强搜索引擎使用体验的 [UserScript](https://www.tampermonkey.net/) 项目。

- **当前主力引擎**：Bing（`www.bing.com` / `cn.bing.com` 搜索结果页）
- **预留扩展**：Google、百度（适配器已写好骨架，尚未接入调度）
- **构建**：TypeScript → esbuild → 单个 `dist/search-enhance.user.js`

---

## 快速开始

```bash
npm install       # 安装依赖
npm run watch     # 监听 src/ 变更，自动重建
npm run build     # 单次构建
npm run check     # 仅做 TypeScript 类型检查
npm run verify    # 类型检查 + 构建
```

构建产物 `dist/search-enhance.user.js` 已进 `.gitignore`，属于生成物。

> **Windows 装依赖提示**：新版 npm 会拦截 esbuild 的 postinstall（`npm warn install-scripts`），
> 二进制可能没落地。若 `npm run build` 报找不到 esbuild，用系统 Node 补跑一次：
>
> ```bash
> "C:/Program Files/nodejs/node.exe" node_modules/esbuild/install.js
> ./node_modules/.bin/esbuild --version   # 应输出版本号
> ```

### 安装到浏览器

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 打开扩展面板 → 添加新脚本 → 把 `dist/search-enhance.user.js` 全文粘贴进去 → 保存。
3. 访问 <https://www.bing.com/search?q=test> 查看效果。

开发时也可以开启 `file://` 直读，把 `meta.ts` 里的 `@match` 换成你的本地文件路径。

---

## 目录结构

```
src/
├── index.ts                 入口：启动 Runner
├── meta.ts                  单一元信息来源（@match / @grant / 版本头）
├── types/
│   ├── engine.ts            EngineAdapter 接口 —— 新增引擎只需实现它
│   ├── feature.ts           Feature 接口 —— 新增功能只需实现它
│   ├── env.d.ts             GM API 声明
│   └── css.d.ts
├── core/
│   ├── runner.ts            调度：识别引擎 → 按开关执行功能
│   ├── env.ts               GM 封装、设置存储、样式注入、菜单注册
│   └── dom.ts               waitForSelector / SPA 导航监听 / 文本归一化
├── engines/
│   ├── index.ts             引擎注册表（enabled 控制是否参与匹配）
│   ├── bing.ts              ✅ 已接入
│   ├── google.ts            ⏸ 预留
│   └── baidu.ts             ⏸ 预留
├── features/
│   ├── index.ts             功能注册表（顺序即执行顺序）
│   ├── hide-ads.ts          隐藏广告位
│   └── result-navigation.ts j / k 键盘导航 + 链接新标签打开
└── styles/main.css
```

---

## 架构约定

### 引擎适配（`EngineAdapter`）

搜索引擎之间差异很大，所以**所有选择器都收敛在 `engines/*.ts` 里**，功能模块不允许直接写 `querySelector('#b_results')` 这类引擎专属代码。适配器职责：

| 成员 | 说明 |
| --- | --- |
| `isSearchPage` | 该 URL 是否搜索结果页 |
| `parseQuery` | 取出搜索词（Bing 用 `q`，百度用 `wd`） |
| `resultContainerSelector` | 结果容器，供 `waitForSelector` 等待 |
| `resultItemSelector` | 单条结果节点 |
| `getAdSelectors` | 广告 / 推广位选择器 |
| `extractResults` | 提取标题、链接、摘要 |
| `isAlreadyInjected` / `markInjected` | 防止 SPA 重复注入 |

### 功能模块（`Feature`）

一个功能只描述「做什么」，不关心在哪个引擎上做。三个方法：

- `supports(engine)` —— 是否在当前引擎生效
- `onNavigate(ctx)` —— 首次加载和每次换词后都会执行，**必须自己保证幂等**
- `dispose()` —— 引擎切换时清理副作用

开关状态存在 GM 存储里（`search-enhance:features`），Tampermonkey 菜单里可逐项开关。

### SPA 导航

Bing / Google / 百度换词都不刷新整页，只改 URL 和部分 DOM。因此 `onUrlChange()` 同时打了 `pushState` / `replaceState` 补丁和 `popstate` 监听——只靠 `popstate` 会漏掉大部分换词。

---

## 接入 Google / 百度

三步：

1. 在 `src/engines/index.ts` 里把对应条目改为 `enabled: true`。
2. 把 `src/meta.ts` 中 `MATCHES_FUTURE` 的规则移入 `MATCHES_ACTIVE`。
3. 实测校正适配器里的选择器——**这是最容易出错的一步**，务必在真实结果页上验证。

---

## 已实现功能

| 功能 | ID | 说明 |
| --- | --- | --- |
| 隐藏广告位 | `hide-ads` | 折叠 Bing 结果页广告模块 |
| 结果键盘导航 | `result-navigation` | `j` / `k` 移动焦点，`Enter` 打开；结果链接默认新标签页 |

---

## 说明

- 打包产物通过 `banner` 注入 `==UserScript==` 头，版本号从 `package.json` 读取，**改版本只需改 `package.json`**。
- GM API 不可用时（如在控制台直接调试）会自动回退到 `localStorage`，不报错。
- 需要远程接口时记得在 `meta.ts` 的 `GRANTS` 里补 `@connect`。

## License

MIT

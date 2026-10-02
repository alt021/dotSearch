# Search Enhance

一个增强搜索引擎使用体验的 [UserScript](https://www.tampermonkey.net/) 项目。

- **当前主力引擎**：Bing（`www.bing.com` / `cn.bing.com` 搜索结果页）
- **预留扩展**：Google、百度（适配器已写好骨架，尚未接入调度）
- **构建**：TypeScript → esbuild → 单个 `dist/search-enhance.user.js`

---

## 快速开始

```bash
npm install       # 安装依赖
npm run watch     # 监听 src/ 变更，自动重建（开发版）
npm run serve     # 起本地服务，供 Tampermonkey 以 URL 安装
npm run build     # 单次构建（正式版）
npm run check     # 仅做 TypeScript 类型检查
npm run verify    # 类型检查 + 构建
```

构建产物已进 `.gitignore`，属于生成物：

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run build` | `dist/search-enhance.user.js` | 正式版，`@updateURL` 指向 GitHub raw |
| `npm run watch` | `dist/dev/search-enhance.user.js` | 开发版，`@updateURL` 指向本机服务 |

> **Windows 装依赖提示**：新版 npm 会拦截 esbuild 的 postinstall（`npm warn install-scripts`），
> 二进制可能没落地。若 `npm run build` 报找不到 esbuild，用系统 Node 补跑一次：
>
> ```bash
> "C:/Program Files/nodejs/node.exe" node_modules/esbuild/install.js
> ./node_modules/.bin/esbuild --version   # 应输出版本号
> ```

---

## 安装到 Tampermonkey

推荐用**方式 A（URL 安装）**，因为改完代码只需刷新页面就能生效，不用反复复制粘贴。

### 方式 A：本地服务安装（推荐，开发用）

需要两个终端。

```bash
# 终端 1 —— 起服务
npm run build:dev
npm run serve
# 输出：[serve] 安装地址：http://127.0.0.1:8777/search-enhance.user.js

# 终端 2 —— 监听重建（改完代码自动生效）
npm run watch
```

然后：

1. 浏览器里打开 <http://127.0.0.1:8777/search-enhance.user.js>
2. Tampermonkey 会弹出安装页 → 点 **安装**
3. 打开 <https://www.bing.com/search?q=test>，广告位应已隐藏

之后每次改 `src/` 的代码，`npm run watch` 会自动重建，`dist/dev` 已设 `Cache-Control: no-store`，
**刷新 Bing 页面即可看到新效果**。脚本名带 `(Dev)` 后缀，可与正式版共存。

> 服务默认只监听 `127.0.0.1:8777`，不对外网暴露。换端口用 `npm run serve -- --port 9000`
> （同时要改 `src/meta.ts` 的 `DEV_SERVER`）。

### 方式 B：手动粘贴（一次性安装）

1. 跑 `npm run build`
2. Tampermonkey 图标 → **添加新脚本**（或新建空脚本后全选删除默认内容）
3. 把 `dist/search-enhance.user.js` 全文粘贴进去
4. `Ctrl+S` 保存

缺点：每次改代码都要重新复制一遍。

### 方式 C：正式发布后自动更新

推到 GitHub 后，`npm run build` 产物的 `@updateURL` 指向
`raw.githubusercontent.com/alt021/...`，Tampermonkey 会自动检查并升级。
用户侧同样只需打开那个 URL 首次安装。

---

## 验证是否生效

装好后按以下顺序检查：

1. 打开 <https://www.bing.com/search?q=test>，广告位应消失
2. 点扩展图标 → 菜单里应出现 `☑ 隐藏广告位`、`☑ 结果键盘导航`
3. 在搜索结果页按 `j` / `k`，当前项应有蓝色高亮并滚动到视野中央
4. 换一个搜索词，**不应刷新页面**，高亮功能仍可用（验证 SPA 导航监听）

排查：菜单里点 `🐛 切换调试日志` 打开日志，再刷新页面，控制台会输出 `[search-enhance]` 开头的诊断信息。

---

## 常见问题

**脚本没反应？**

- 确认当前 URL 匹配 `@match *://*.bing.com/search*`，且是**搜索结果页**（路径必须是 `/search`）
- Tampermonkey 图标里确认脚本处于启用状态
- 打开调试日志看控制台输出

**菜单是英文 / 功能没出现？**

- GM 菜单与设置依赖 `@grant`，浏览器若禁用了用户脚本权限会退化
- 菜单项只在脚本成功匹配到引擎后才注册

**改了代码没变化？**

- 确认 `npm run watch` 正在运行
- 强制刷新（`Ctrl+Shift+R`）排除浏览器缓存
- 确认装的是 Dev 版而非正式版（看脚本名有没有 `(Dev)`）

**esbuild 报 EBUSY / 找不到二进制？**

见上文「Windows 装依赖提示」。本质是托管版 `node.exe` 被锁，用系统 Node 补跑 `install.js` 即可。

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

scripts/
├── build.mjs                 esbuild 打包（支持 --dev / --watch / --minify）
└── serve.mjs                 本地静态服务，供 Tampermonkey 以 URL 安装
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

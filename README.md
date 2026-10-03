# Search Enhance

一个**重写搜索引擎结果页**的 [UserScript](https://www.tampermonkey.net/) 项目。

不是给原站打补丁，而是把结果页整个换掉：用统一结构重建结果列表，
再在此之上做完整的视觉风格化。

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

1. 打开 <https://www.bing.com/search?q=test>，页面应只剩搜索框与结果列表
2. 顶栏、页脚、侧栏、广告、Copilot 面板应全部消失
3. 鼠标移到**屏幕右边缘**（约 48px 内），应滑出一小条深色提示；点击它展开**右侧工具栏**
4. 工具栏内含账户入口（未登录显示「点击登录 Bing」，已登录显示「已作为 X 登录」）、
   Microsoft Rewards 与搜索设置；展开时页面会被黑色叠加层压暗
4. 结果链接应指向**真实站点地址**（而非 `bing.com/ck/a` 中转），点击在新标签打开
5. 页面 DOM 应大幅缩减（实测 378 → 56 节点）

排查：在控制台执行 `window.__searchEnhanceDebug__ = true` 后刷新，
即可看到 `[search-enhance]` 开头的 info 级日志；
关键诊断（如重写完成、分页缺失）一律以 `console.warn` 输出，无需开关即可见。

---

## 常见问题

**脚本没反应？**

- 确认当前 URL 匹配 `@match *://*.bing.com/search*`，且是**搜索结果页**（路径必须是 `/search`）
- 若结果区正常但样式全无，说明 `src/styles/base.css` 未注入
- Tampermonkey 图标里确认脚本处于启用状态
- 打开调试日志看控制台输出

**右侧工具栏不出现？**

- 它只在搜索结果页挂载；把鼠标移到屏幕**最右侧**（约 48px 内）才会露出提示条
- 若一直不出来，确认脚本已启用且页面已被重写（正文应是干净的列表）

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
│   ├── runner.ts            调度：识别引擎 → 依次执行各功能
│   ├── env.ts               GM 封装、设置存储、样式注入、菜单注册
│   └── dom.ts               waitForSelector / SPA 导航监听 / 文本归一化
├── engines/
│   ├── index.ts             引擎注册表（enabled 控制是否参与匹配）
│   ├── bing.ts              ✅ 已接入
│   ├── google.ts            ⏸ 预留
│   └── baidu.ts             ⏸ 预留
├── features/
│   ├── index.ts             功能注册表（顺序即执行顺序）
│   └── strip-to-results.ts  结果页重写（当前唯一功能）
└── styles/base.css           重建后的基础样式

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

## 当前进度

### 已实现：结果页重写（`strip-to-results`）

把 Bing 结果页替换为「搜索框 + 干净结果列表」：

- 清空原站全部内容与样式（顶栏、页脚、侧栏、广告、Copilot 面板、浮层）
- 用 `EngineAdapter` 解析结果为结构化数据，**不复用任何原站节点**
- 从零构建 `se-*` 结构：标题 / 来源 URL / 摘要三层
- 解析 Bing 跳转链接 `bing.com/ck/a`，还原为真实地址
- 保留分页与顶部直答区（后期统一重写）
- 补一个搜索框（原站搜索框随重写移除，详见下方「已知取舍」）

实测（真实 Bing 快照 + 本机 Chromium）：DOM **378 → 56 节点**，10 条结果全保留，
原站元素与 `li.b_algo` 残留均为 0，跳转链接残留 0。

### 已知取舍

原站搜索框位于 `#b_header`，会随重写一起消失，其 `pushState` 换词机制也随之失效。
因此重建了搜索框并改用 `location.assign` 整页跳转——每次搜索都会整页加载，
牺牲了 SPA 的即时性，换来脚本能稳定重新初始化。

### 视觉风格：瑞士风格（已完成首版）

采用 International Typographic Style，用排版本身建立层级而非装饰：

**设计决策**

| 维度 | 做法 |
| --- | --- |
| 网格 | 左栏等宽序号（01/02…）+ 右栏内容， 强列对齐 |
| 字体 | Helvetica 系无衬线；序号与来源 URL 用等宽字体区分层级 |
| 色彩 | 纯黑白 + 唯一强调红 `#E30613`（瑞士国旗色），全站仅此一色 |
| 分隔 | 细规则线切割条目，**不用卡片阴影** |
| 留白 | 大间距是版面组成，不是浪费 |
| 拒绝 | 无圆角、无阴影、无渐变、无悬浮抬升 |

DOM 结构相应调整：新增 `se-num` 序号栏、`se-body` 内容栏、`se-masthead` 页头
（品牌方块 + 查询词大字 + 结果计数，以 3px 粗规则线收束）；来源 URL 移至标题之上，
即瑞士风格典型的元信息前置手法。

**深色模式**：跟随系统 `prefers-color-scheme`，深色下强调红提亮至 `#ff2a34` 保证对比度。
两种模式均已截图实测。

验证：

```bash
npm run verify:strip           # 浅色
npm run verify:strip -- --dark # 深色
```

### 下一步

精修方向：字距与比例微调、悬停动效、中文排版优化、favicon 提取、
搜索结果高亮关键词、宽屏多列布局等。

## 说明

- 打包产物通过 `banner` 注入 `==UserScript==` 头，版本号从 `package.json` 读取，**改版本只需改 `package.json`**。
- GM API 不可用时（如在控制台直接调试）会自动回退到 `localStorage`，不报错。
- 需要远程接口时记得在 `meta.ts` 的 `GRANTS` 里补 `@connect`。

## License

MIT

# dotSearch

一个**重写搜索引擎结果页**的 [UserScript](https://www.tampermonkey.net/) 项目。

不是给原站打补丁，而是把结果页整个换掉：用统一结构重建结果列表，
再在此之上做完整的视觉风格化。

- **当前主力引擎**：Bing。搜索前端有多个**等价**入口：
  `www` / `cn` / `www2` / `www4` …（必应按 IP 分流，同一个域名在不同
  网络下给出中国版或全球版；备用子域也随可用性增删）。
  脚本用 `*.bing.com` 通配注入，站点识别走**后缀判定**，新增别名无需改代码。
- **预留扩展**：Google、百度（适配器已写好骨架，尚未接入调度）
- **构建**：TypeScript → esbuild → **每个引擎一个独立产物**
  （`dist/dotSearch-bing.user.js`）。一份源码、按 `--engine=<id>` 分别产出，
  各引擎的 `@match` 与脚本体名互不干扰

---

## 快速开始

```bash
npm install         # 安装依赖
npm run watch       # 监听 src/ 变更，自动重建（开发版）
npm run serve       # 起本地服务，供 Tampermonkey 以 URL 安装
npm run build       # 单次构建（正式版，仅 bing）
npm run build:all   # 构建全部已启用引擎的产物
npm run check       # 仅做 TypeScript 类型检查
npm run verify      # 类型检查 + 构建
npm run release     # 构建 + 产物自检 + 发版前检查（见「验证体系」）
```

构建产物已进 `.gitignore`，属于生成物：

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run build` | `dist/dotSearch-bing.user.js` | 正式版，`@updateURL` 指向仓库地址 |
| `npm run watch` | `dist/dev/dotSearch-bing.user.js` | 开发版，`@updateURL` 指向本机服务 |

> 产物名由 `src/meta.ts` 的 `ENGINE_BUILDS[engine].slug` 决定，
> `scripts/build.mjs` 与 `scripts/serve.mjs` 都从那里取 —— **改名只改这一处**。
> 早期版本把文件名写死在 5 个地方，改名时漏一处就会得到一条 404 的安装链接。

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
# 输出：[serve] 安装地址：http://127.0.0.1:8777/dotSearch-bing.user.js

# 终端 2 —— 监听重建（改完代码自动生效）
npm run watch
```

然后：

1. 浏览器里打开 <http://127.0.0.1:8777/dotSearch-bing.user.js>
2. Tampermonkey 会弹出安装页 → 点 **安装**
3. 打开 <https://www.bing.com/search?q=test>，广告位应已隐藏

之后每次改 `src/` 的代码，`npm run watch` 会自动重建，`dist/dev` 已设 `Cache-Control: no-store`，
**刷新 Bing 页面即可看到新效果**。脚本名带 `(Dev)` 后缀，可与正式版共存。

> 服务默认只监听 `127.0.0.1:8777`，不对外网暴露。换端口用 `npm run serve -- --port 9000`
> （同时要改 `src/meta.ts` 的 `DEV_SERVER`）。

### 方式 B：手动粘贴（一次性安装）

1. 跑 `npm run build`
2. Tampermonkey 图标 → **添加新脚本**（或新建空脚本后全选删除默认内容）
3. 把 `dist/dotSearch-bing.user.js` 全文粘贴进去
4. `Ctrl+S` 保存

缺点：每次改代码都要重新复制一遍。

### 方式 C：正式发布后自动更新

`meta.ts` 里正式版的 `@updateURL` / `@downloadURL` 指向
`raw.githubusercontent.com/alt021/dotSearch/main/dist/dotSearch-bing.user.js`。
配好之后，Tampermonkey 会自动检查并升级，用户侧只需打开那个 URL 首次安装。

> **注意**：仓库当前**不提交 `dist/`**（它属于生成物，见上表）。
> 因此上面那个地址目前取不到文件，方式 C 要等下面任一件事做完才可用：
>
> - 加一个 CI（如 GitHub Actions）在推送时构建并发布产物；
> - 或改主意把 `dist/dotSearch-bing.user.js` 纳入版本控制；
> - 或把构建产物挂到 Release，让 `@updateURL` 指向 Release 资产地址。

---

## 验证是否生效

装好后按以下顺序检查：

1. 打开 <https://www.bing.com/search?q=test>，页面应只剩搜索框与结果列表
2. 顶栏、页脚、侧栏、广告、Copilot 面板应全部消失
3. 页头「BING — 检索」那一行的末尾有 **菜单** 按钮，点开可见 **附加设置**
   （本脚本自己的功能，排在第一位；结果过滤是它的子页）、账户入口
   （未登录显示「点击登录 Bing」，已登录显示「已作为 X 登录」）、
   Microsoft Rewards 与搜索设置
4. 结果链接应指向**真实站点地址**（而非 `bing.com/ck/a` 中转），点击在新标签打开
5. 页面 DOM 应大幅缩减（实测 378 → 56 节点）
6. 在「附加设置 → 结果过滤」里加一条 `csdn.net` → 选「隐藏该结果」，
   对应条目应立即变为灰字占位，单击可正常恢复
7. 窄屏（≤600px）下页头、列表、分页应各自收成单列，分页变成 **PREV / NEXT**

排查：在控制台执行 `window.__searchEnhanceDebug__ = true` 后刷新，
即可看到 `[dotSearch]` 开头的 info 级日志；
关键诊断（如重写完成、分页缺失）一律以 `console.warn` 输出，无需开关即可见。

---

## 与东方永页机（Pagetual）协同

本脚本重写页面时会**保留必应原始 DOM**（移入隐藏容器 `#se-source`，
不可见也不占位），而不是删除它 ——
因为自动翻页脚本是「自驱动」的：它要靠当前页的结构去定位
「下一页链接」与「主内容容器」。删掉这些锚点，它就无从下手。

### 一条逻辑同时管桌面端与手机端

两端的差别只有**新页插在哪个容器里**：

| | 新页插到哪 | 我们的处理 |
| --- | --- | --- |
| 桌面端 | `#b_results`（已随原站 DOM 进 `#se-source`） | 本来就在数据源里，无需额外动作 |
| 手机端 | 不定 —— 可能在 `#se-source` 外，也可能**插进我们的列表里** | 每次同步全量归拢，一律搬进 `#se-source` |

所以「数据源」不再等同于 `#se-source` 这一个元素，而是
**页面里所有原站结果条目**（`li.b_algo`）。具体三处：

- **观察**：`MutationObserver` 挂 `document.body` 整棵子树，只看 `addedNodes`，
  只负责判断「有没有动静」，不决定「该搬到哪」。
- **归拢**：`sync()` 开头做一次全量扫描，页面上所有不属于我们的原站条目
  （连同其所在容器）搬进 `#se-source` —— 不可见、可采集。
- **采集**：全页找原站结果条目，按**条目的父元素**分组交给
  `engine.extractResults()`。刻意不按固定容器选择器取 ——
  手机端插入的容器未必叫 `#b_results`，而「有条目就有父元素」永远成立。

⚠️ **先归拢、后采集，顺序不能反**：归拢把可见的原版内容搬进数据源，
紧接着的采集才读得到；反过来会出现「这一轮只看到旧内容」。
**只采集不归拢，就是「内容渲染出来了、原版还留在页面上」**。

### 手机端它会插进我们的界面里（实测）

`#se-source` 用的是 1px 裁剪（不是 `display:none`，永页机需要节点仍在渲染），
但永页机的 pageElement 检测会认为它「太小/不可用」，转而挑**页面上可见的
列表**。手机端实测它选中了我们的 `ol.se-list`：

```
【Pagetual】 Page element: body > div.se-source+div > main.se-main > ol.se-list
```

于是新页会被插进 `#se-root` 内部 —— 如果观察器简单地「跳过 `#se-root`」，
这些内容既不采集也不收纳，就以原站样式留在列表后面（序号还是原站的 1、2、3）。

因此判断"是不是我们自己的界面"用的是**节点归属**（属于 `.se-item` /
`.se-extra`）而不是「在不在 `#se-root` 内」。

### 归拢：先搬走，再采集（不要按插入位置分流）

真正把原版块从页面上抹掉的，是 `sync()` 开头那次**全量归拢**
（`sweepVisibleResults`），顺序不能反：

```
sweepVisibleResults()   // 页面上所有不属于我们的原站条目 → 搬进 #se-source
collectUnrendered()     // 再从数据源采出新增的 → 渲染成 .se-item
```

- 只问一句「页面上还有没有不属于我们的原站结果条目」，有就搬走 ——
  不管永页机怎么插、插到哪。
- 条目所在的**结果容器**（`ol` / `#b_results` 一类）整块搬，免得留下空壳；
  但向上最多爬三层，且一旦发现该节点包含 `#se-root` / `.se-list` / `.se-item`
  就立刻放弃，退化为只搬条目本身。
- 它的「Page N」分页条一并收走（纯装饰）。

⚠️ **早期版本按 mutation 节点的位置分流**（在 `#se-root` 内就搬、在页面外
加类隐藏）。真机结果是「内容采到了、原版块仍留在页面上」——
永页机的插入方式与落点随版本、布局变化，按位置猜分支必然漏。
现在 mutation 只负责「有没有动静」，该做什么统一由归拢那句判据决定。

### 每页条数必须用「实际结果数」兜底

手机端一页只给 8 条（桌面 10 条），而分页控件往往只暴露一个 `first=`
（只有「下一页」），偏移量集合里没有相邻差 → `detectPageSize()` 会回退到 10。
于是 `first=9` 被算成 `floor(9/10)+1 = 1`：

- 页号错成第 1 页 → 序号偏移为 0 → **第二页又从 01 开始**；
- `maxPage` 算成 1 → PREV / NEXT 两个方向都没有目标 → 整行不渲染。

`extractPaginationLinks()` 因此接收当前页实际条数作为 `sizeHint`，
在偏移量推不出每页条数时用它兜底（`first=9`、每页 8 条 → 第 2 页 ✓）。

### 触发与去重

监听永页机的 `postMessage`（`insert` / `lastPage`）作为主信号，
`MutationObserver` 兜底。每次变化后按 URL 去重、只追加新条目，
永不重建列表（重建会丢滚动位置与悬停状态）。

去重集合读的是条目的 `dataset.seHref` 而不是链接的 `href`：
被 hide 规则命中的条目会摘掉 `href`（占位条不是链接），
只看 `href` 会让它们每轮都被当成「新结果」重复追加。

过滤规则改动触发列表整表重建后，`strip-to-results` 会派发
`dotsearch:results-rerendered`，协同模块收到后补采一次 ——
重建只覆盖首次重写的结果，永页机追加的页要靠这一步补回来。

### 序号与页号

- 序号是**全局**的：第 2 页（`first=11`、每页 10 条）的第一条是第 11 条结果，
  从 `pageStartIndex()` 起算，不重新从 01 数。永页机拼接时在
  「已渲染条数 + 当前页起点」上续号。
- 页头在条数后附「· 第 N 页」（N>1 时显示）。N 按**已渲染条数**推算，
  所以永页机每拼进一页、条数跨过页边界，页号会自己 +1。

### 如果自动识别不生效

永页机的自动识别是启发式的，可能挑不到正确节点。
本项目提供了一份显式规则，导入后即可确定下来：

`docs/pagetualRule.json`

```json
[
  {
    "name": "必应 + dotSearch",
    "author": "dotSearch",
    "example": "https://www.bing.com/search?q=test",
    "url": "^https?://([a-z0-9-]+\\.)?bing\\.com/search",
    "nextLink": "#se-source .sb_pagN, #se-source .sb_pagNext, #se-source a[aria-label=\"下一页\"], #se-source a[href*=\"first=\"]",
    "pageElement": "#b_results"
  }
]
```

`url` 用子域通配而不是 `(www|cn)`：备用入口（www2 / www4）是实际可用的，
写死两个子域会让这些站点上**规则根本不匹配、翻页压根不启动**。

导入方式：永页机设置页 → 规则 → 导入上述 JSON。
⚠️ 规则改过之后需要在永页机里**重新导入**才会生效。

### 已知限制

- 永页机若配置为 iframe 模式（规则里的 `action` 为 1 或 2），
  新页内容会以 iframe 呈现，本脚本无法把它接进列表。
  默认的「抓取静态 HTML 后插入」模式不受影响。
- 协同生效后，页面的页码导航仍然保留，两种翻页方式并存。
- 能否翻页取决于永页机能否在当前页找到「下一页链接」。
  手机端原站分页结构与桌面不同；若它找不到锚点，就不会翻页，
  此时问题不在采集层。


---

## 常见问题

**脚本没反应？**

- 确认当前 URL 匹配 `@match *://*.bing.com/search*`，且是**搜索结果页**（路径必须是 `/search`）
- 若结果区正常但样式全无，说明 `src/styles/base.css` 未注入
- Tampermonkey 图标里确认脚本处于启用状态
- 打开调试日志看控制台输出

**菜单按钮不出现？**

- 它只在搜索结果页挂载，位置在页头「BING — 检索」那一行的末尾
- 确认脚本已启用且页面已被重写（正文应是干净的列表）

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
├── meta.ts                  单一元信息来源（按引擎的 @match、产物名、@grant、版本头）
├── types/
│   ├── engine.ts            EngineAdapter 接口 —— 新增引擎只需实现它
│   ├── feature.ts           Feature 接口 —— 新增功能只需实现它
│   ├── env.d.ts             GM API 声明
│   └── css.d.ts
├── core/
│   ├── runner.ts            调度：识别引擎 → 依次执行各功能
│   ├── env.ts               日志、样式注入
│   └── dom.ts               waitForSelector / SPA 导航监听 / 文本归一化
├── engines/
│   ├── index.ts             引擎注册表（enabled 控制是否参与匹配）
│   ├── bing.ts              ✅ 已接入（含账户入口、设置页折叠清单）
│   ├── google.ts            ⏸ 预留
│   └── baidu.ts             ⏸ 预留
├── features/
│   ├── index.ts             功能注册表（顺序即执行顺序）
│   ├── strip-to-results.ts  结果页重写：重建页面 + 保留隐藏数据源 + 分页 + 序号
│   ├── tool-menu.ts         页头「菜单」按钮与弹出面板
│   ├── filter-store.ts      过滤规则存储（GM 脚本级存储，跨源共享）
│   ├── filter-panel.ts      过滤设置浮层（嵌在「附加设置」里）
│   ├── settings-panel.ts    「附加设置」总面板（过滤是它的子页）
│   ├── settings-store.ts    各项开关的持久化
│   ├── settings-cleanup.ts  在必应设置页折叠已被本脚本取代的项
│   ├── privacy.ts           链接净化（去掉追踪参数，可选）
│   └── pagetual-bridge.ts   永页机协同：把新加载的内容接进列表
└── styles/base.css           重建后的基础样式（含响应式断点）

scripts/
├── lib/browser.mjs           测试浏览器入口（统一指向本机 Chromite）
├── build.mjs                 esbuild 打包（支持 --dev / --watch / --engine）
├── build-engine.mjs          按引擎构建（位置参数，避开 shell 吞引号）
├── serve.mjs                 本地静态服务，供 Tampermonkey 以 URL 安装
├── fetch-sample.mjs          抓取真实 Bing 结果页快照
├── fetch-settings-page.mjs   抓取必应设置页快照（验证折叠用）
├── verify-strip.mjs          离线快照验证（不依赖网络，深度断言）
├── verify-live.mjs           实时站点验证（真实 Bing，可换入口 / 代理）
├── verify-responsive.mjs     窄屏版式验证（只改视口宽度，见其注释）
├── verify-pagination.mjs     分页提取与序号验证
├── verify-settings.mjs       附加设置与设置页折叠验证
├── verify-sanitize.mjs       链接净化单测
├── verify-artifacts.mjs      产物自检（头部、产物名、@match）
├── verify-release.mjs        发版前检查
└── check-underline.mjs       菜单文字下划线目视校验（需人工看截图）

assets/icon/                  标识（唯一来源，README 与 @icon 共用）
├── dotsearch.svg             图标正版：#111 + #E30613，透明底
├── dotsearch-reverse.svg     反白版：深色底用，#FFF + #FF2A34
├── lockup.svg                图标 + 字标（README 页头）
├── lockup-dark.svg           同上，反白
└── preview.html              标识规格页（正/反、尺寸阶梯、构造取值、色值）
```

---

## 架构约定

### 按引擎构建（一份源码，多个产物）

项目从「一个脚本兼容多引擎」改为**每个引擎一个独立脚本**：
每个引擎有自己的 `@match` 集合与脚本体名，安装后互不干扰。

- `src/meta.ts` 的 `ENGINE_BUILDS` 是唯一配置点：`displayName`、`slug`、`matches`。
  新增引擎在这里加一项，构建侧只需 `--engine=<id>`。
- 构建时通过 esbuild 的 `define` 注入 `__SE_TARGET_ENGINE__`，
  运行期由 `engines/index.ts` 据此**只启用目标引擎** ——
  一份源码不会在错误站点上注册多余的适配器。
- 产物名由 `slug` 派生（`dotSearch-bing.user.js`），
  构建脚本、本地服务、验证脚本都从同一处取，**不写死文件名**。

### 标识与图标（`assets/icon/`）

标识与代码分开存放，**唯一来源是 `assets/icon/`**：脚本头部的 `@icon`、
README 的页头都指向那里的文件，改图标只换文件，不动代码。

- `META.icon` 由 `RAW` 前缀派生（与 `@downloadURL` 同一个前缀常量）。
- ⚠️ **与 `@downloadURL` 不同的是它现在就能生效**：`dist/` 是生成物、不提交，
  那个地址要等 CI 或 Release 才通；而 `assets/` 是**源码、会随仓库提交**，
  所以 `@icon` 推送后即可取到 —— 这是图标没有走 `dist/` 的原因。
- ⚠️ **无底板 + 只有黑红的代价：纯黑在深色底上会消失。** 处理办法是每个标识
  配一份反白版（黑→白、红→`#FF2A34`，与深色令牌同值），README 用
  `<picture>` + `prefers-color-scheme` 自动切换。
  ❌ **不要用「加底板」来解决** —— 那等于把图标做成卡片，与「无底板」的约定相抵。
- README 只在顶部放一枚 lockup（图标 + 字标），正文保持原样。
  红色只出现在字标里的 `Search` —— 与站内「红色全站仅一处」是同一条原则。
- ⚠️ README 的图片块要包在 `<p>` 里：裸 `<picture>` 在部分 Markdown 渲染器
  里会被当成行内 HTML，与相邻内容挤到同一行。

#### 图标本身的取值（32 网格）

三根规则线左缘同一起排、右缘参差，**栏高不等**（`5.5` / `4` / `5.5`）——
「有规则、但不规则」，这是它不像菜单图标的原因。红点 `r=4.4`
落在细栏的轴线 `cy=16.25`，**右缘与第一栏右缘严格对齐在 `x=29.5`**。
四边留白 `3.5`。

小尺寸的判据只有一条：**红点在 16px 下必须是能看见的色块**。
初版 `r=3.75` 在浏览器标签页里缩成一个红点，才加到 `4.4`。

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

必应的 `isSearchPage` 用**后缀判定**（`bing.com` 及其任意子域 + `/search`），
而不是主机名白名单。它的搜索前端有 www / cn / www2 / www4 等多个等价入口，
备用子域还随可用性增删 —— 白名单天生追不上，而**漏掉一个的后果不是
「功能降级」，是脚本静默退出、整个增强都不生效**（www4 就这么漏过一轮）。
`hostnames` 字段仅供日志与调试查看，不求穷举，新增别名无需改代码。

同理，菜单里指向站内的入口（登录、搜索设置）取 `location.origin` 而非
写死 `www.bing.com`：用户改用备用域名，往往正是因为 www 那一侧访问不了，
写死就把人弹回打不开的域名。Rewards 例外 —— 它在另一个子域上。

### 功能模块（`Feature`）

一个功能只描述「做什么」，不关心在哪个引擎上做。三个方法：

- `supports(engine)` —— 是否在当前引擎生效
- `onNavigate(ctx)` —— 首次加载和每次换词后都会执行，**必须自己保证幂等**
- `dispose()` —— 引擎切换时清理副作用

所有功能常驻启用 —— 原先的开关机制（Tampermonkey 菜单）已移除。
「附加设置」里的选项只控制**行为细节**（如链接净化、过滤规则），
不控制功能是否加载。

### 响应式与手机端

三档断点：`640px`（页头收窄）、`600px`（主布局）、`480px`（更小的字距与留白）。

窄屏下的取舍：

- 结果条目保持**两列**（序号 + 正文），只把序号列从 `3.5rem` 收到 `1.6rem`，
  `align-items: baseline` 让序号与右栏首行（来源地址）同基线 ——
  早期版本把序号独立成一行，读起来像段标题而不是条目。
- 分页隐藏页码列表，改为 **PREV / NEXT** 两个平分整行的按钮：
  手机上页码一行放不下，换行后每个目标又小到难以点中。
  优先取**原站自己的**翻页链接（`.sb_pagN` / `rel=next` / aria-label），
  没有再按页码推算 —— 手机端原站分页结构不一定有可推算的相邻页。
- 「已排除」标签与标题同行：用我们自己的类名把 `display` 钉成 inline，
  否则原站 `h2 a` 一类通用规则会把标题算成块级、把标签挤到上一行。

⚠️ `verify-responsive.mjs` **只改视口宽度**、用桌面快照、不开
`isMobile` / `hasTouch`；而本地快照没有 viewport meta，
开了 `isMobile` 布局宽度会变成 980px、断点全不生效。
所以那条脚本能守住版式回归，**但不代表真机**。
涉及触摸（点击目标尺寸、hover 门控）的改动必须另做真机/移动模拟验证。

### SPA 导航

Bing / Google / 百度换词都不刷新整页，只改 URL 和部分 DOM。因此 `onUrlChange()` 同时打了 `pushState` / `replaceState` 补丁和 `popstate` 监听——只靠 `popstate` 会漏掉大部分换词。

### document-start 下的安全前提

`@run-at document-start` 意味着脚本会**早于文档树**执行。实测那一刻
`document.documentElement` / `head` / `body` **三者全是 null**，
`document.readyState === 'loading'`。因此启动路径上不能同步访问它们：

- `waitForSelector()` 观察 `document` 本身（任何时刻都是合法 Node），
  而不是 `document.documentElement`；
- `injectStyle()` 在 `head` / `documentElement` 都不存在时先排队，
  等根元素出现再插；
- 注入标记只在启动**成功**后保留。启动若中途失败就撤销标记，
  否则这个文档会被永久判定为「已注入」，后续重试全被挡回 ——
  用户看到的是功能毫无反应，而控制台只有一条启动报错。

国内版（`cn.bing.com`）与国际版（`www.bing.com`）在这条路径上的时序不同：
国际版会多做一次 `rdr=1` 重定向，历史上正是这里出了问题。
`npm run verify:intl` 专门覆盖「国际版 + document-start」这个组合。

---

## 接入 Google / 百度

三步：

1. 在 `src/engines/index.ts` 里把对应条目改为 `enabled: true`。
2. 在 `src/meta.ts` 的 `ENGINE_BUILDS` 里加一项（`displayName` / `slug` /
   该引擎的 `matches`），然后用 `npm run build -- --engine=<id>` 验证产物头部。
3. 实测校正适配器里的选择器——**这是最容易出错的一步**，务必在真实结果页上验证。

---

## 验证体系

`scripts/` 下分两类：**离线快照**（不依赖网络、断言最细）与
**实时站点**（真实必应、能发现线上结构变化）。两者互补，缺一不可。

| 命令 | 覆盖什么 |
| --- | --- |
| `npm run verify:strip` | 离线快照，浅色。重写结构、过滤全流程、样式共存、跨源共享 |
| `npm run verify:strip -- --dark` | 同上，深色 |
| `npm run verify:live` | 实时必应，默认直连（→ `cn.bing.com`） |
| `npm run verify:start` | 实时 + `--document-start`（模拟 Tampermonkey 注入时机） |
| `npm run verify:intl` | 实时 + `--proxy` + `--document-start`（→ `www.bing.com`） |
| `npm run verify:www4` | 同上，换备用入口 `www4.bing.com` |
| `npm run verify:responsive` | 窄屏版式（只改视口宽度，不代表真机，见上文说明） |
| `npm run verify:pagination` | 分页提取、序号与页号 |
| `npm run verify:settings` | 附加设置面板与设置页折叠 |
| `npm run verify:sanitize` | 链接净化单测（不起浏览器） |
| `npm run verify:artifacts` / `release` | 产物自检与发版前检查 |
| `npm run verify:all` | 离线浅色 + 离线深色 + 实时 document-start |

三条经验值得记住：

- **`--document-start` 必须跑。** post-load 注入时 `head` / `body` 早已存在，
  测不出「文档树还没建立就去访问它」这类问题 —— 而线上正是这么挂的
  （国际版整页无反应就是这么来的）。
- **`--proxy` 与 `--host` 都要跑。** 必应按 IP 分流、又有多个等价入口，
  一版的时序问题另一版不一定复现。
- **所有验证统一在本机 Chromite 中运行**（路径在 `scripts/lib/browser.mjs`，
  改浏览器只改这一处）。浏览器进程不能在沙箱里启动，跑验证要放开沙箱。

---

## 当前进度

### 已实现：结果页重写（`strip-to-results`）

把 Bing 结果页替换为「搜索框 + 干净结果列表」：

- 清空原站**内容**（顶栏、页脚、侧栏、广告、Copilot 面板、浮层），
  但**不动它的样式表** —— 见下方「与必应样式表共存」
- 用 `EngineAdapter` 解析结果为结构化数据，**不复用任何原站节点**
- 从零构建 `se-*` 结构：标题 / 来源 URL / 摘要三层
- 解析 Bing 跳转链接 `bing.com/ck/a`，还原为真实地址
- 分页**自己重算**：只从原站读取「有几页」，链接按 `first=` 自己拼
  （原站的 class 名、aria-label、甚至有没有 href 都随地区与实验变化，不可靠）
- 顶部直答区逐项甄别后保留（剔相关搜索、剔内联样式、剔合规链接）
- 补一个搜索框（原站搜索框随重写移除，详见下方「已知取舍」）

实测（真实 Bing 快照 + 本机 Chromite）：DOM **378 → 56 节点**，10 条结果全保留，
原站元素与 `li.b_algo` 残留均为 0，跳转链接残留 0。

序号是**全局**的：第 2 页的第一条是第 11 条结果，不从 01 重数；
页头在条数后附「· 第 N 页」。详见「与东方永页机协同 → 序号与页号」。

### 已实现：结果过滤（`filter-store` + `filter-panel`）

从页头「菜单 → **附加设置** → 结果过滤」打开的浮层里，按**域名**配置处理方式
（早期版本这里是菜单里的独立入口「结果过滤设置」，重构后收进附加设置）：

| 方式 | 表现 |
| --- | --- |
| 加「已排除」标签 | 结果照常显示、可正常跳转，只在标题文字**之前**加一个描边小标签 |
| 隐藏该结果 | 结果**不删除**：保留原序号与位置，标题区灰字显示「该结果已隐藏」，摘要收起 |

隐藏项可以**单击恢复**：点击后拿回链接、摘要与全部样式，
与从未被隐藏过的条目**逐字段一致**（这一点由验证脚本逐项比对，而非目视）。

几个设计决定：

- **按站点归并，只留注册域名**。规则统一收敛成两段（`csdn.net`）：
  用户粘贴 `https://blog.csdn.net/xxx` 或写 `post.csdn.net`，
  存下来的都是 `csdn.net`，因此同一个站点的任意子域共用一条规则，
  不必为 `blog.` / `www.` / `post.` 分别配置。
  例外是一份**多段后缀**名单（`dpdns.org`、`us.kg`、`qzz.io`、`xx.kg`、
  `eu.org`、`de5.net`、`ggff.net`、`finegear-sg.me`、`eu.cc`）——
  这些后缀本身由两段组成，真正的注册域名是它的上一层，
  所以保留三段（`xxx.xxx.xxx`）。
- **输入容忍度高**。直接粘贴完整结果地址也能识别，
  自动剥掉协议、路径、端口、`user@`；不像域名的输入会被拒绝且给出可见提示。
- **改动即时生效，不设「保存」按钮**。域名列表本身就是最终状态；
  每次改动写回存储并整表重建结果列表 —— 过滤是全局性改动，
  重建后序号与隐藏态统一重算，比逐条打补丁更不容易留下不一致。
- **读取时重放规范化**。规范化规则会随版本变化，
  所以 `getRules()` 读出来会再规范化一次并合并去重，
  而不是把不符合当前规则的旧数据当脏数据丢掉 ——
  否则用户升级后会发现规则凭空消失。
- **规则存脚本级存储（`GM_getValue` / `GM_setValue`），而不是 `localStorage`**。
  这是**用户级**偏好，要跨会话保留，与页面级状态（如查询词回填）不是一回事。
  更要紧的是**跨源**：必应按 IP 分流，`cn.bing.com` 与 `www.bing.com`
  是两个源，而 `localStorage` 按源隔离 —— 用它会导致
  「在 cn 配好的屏蔽项，到 www 上看不到、改不动、也不生效」。
  脚本级存储是同一个脚本的所有 `@match` 共用一份，正好对症，
  为此多两条 `@grant` 是值得的（早期为省权限而用 `localStorage`，是个判断失误）。
  `localStorage` 保留作**回退**（不在脚本管理器里运行时，如控制台调试与
  本仓库的验证脚本）与**迁移**（旧版本只写 localStorage，
  首次读到共享存储「从未写过」时搬过去，升级后规则不会消失）。
  已知限制：跨标签实时同步没做，改动在下一次重写时生效。
- **单击恢复用事件委托**。条目会被增量追加（永页机）与整表重建（改规则），
  逐条绑定必然漏掉后来者，所以监听器挂在根容器上、走捕获阶段。
- **与必应样式表共存，而不是把它关掉**。必应的通用选择器会盖掉我们新写的
  元素（实测面板里的输入框被染成 `#444` 文字配 `#ddd` 边框，暗色下尤其明显）。
  曾经的做法是把原站样式表整体 `disabled`，但那个做法**已经回退** ——
  代价远大于收益：
  - 会连带关掉**别的脚本**的样式。东方永页机（Pagetual）的侧边浮动工具条
    是它自己注入 CSS 渲染的，一并禁用后完全不成样子，而它是本项目要协同的对象；
  - 会让**原本靠原站 CSS 隐藏的元素全部显形**。实测必应会往 body 插
    `div.overlay-dimmer`（`position:fixed`、`z-index:9998`、`pointer-events:auto`、
    铺满视口），它只靠必应样式表里的 `.b_hide { display:none }` 才不显示 ——
    CSS 一禁，它就成了全屏点击拦截层，整页点不动。
  现在改为两个更精确的手段：
  1. 我们的控件配色由**自己的 `!important`** 兜底（只写自己的类名，
     绝不波及第三方）；
  2. 必应确实不该出现在重写页上的 UI（选中文字的 QuickSearch 浮窗、
     重写后被脚本插回的顶栏页脚与遮罩）用**按 id 精确命中**的规则隐藏，
     清单刻意不含 `#b_results` / `.b_pag` —— 那是永页机定位用的锚点。
- **过滤浮层挂在 `#se-root` 里，不挂 `document.body`**。必应国际版自带一个
  MutationObserver，会把 body 下它不认识的子节点直接摘掉 —— 浮层挂到 body 后
  几毫秒就被删除：面板「打开又消失」，连关闭回调都没触发过，
  用户看到的就是「过滤面板打不开」。挂进我们自己的根容器即绕开该守卫。

验证覆盖（`verify:strip` 的「结果过滤」段）：
浮层开合与增删改、无效输入拦截、同域名去重、
badge 标签位置与结果完好性、hide 保留序号与灰字占位、
单击恢复、恢复后与普通条目逐字段一致、规则跨刷新持久化；
以及「样式共存」：原站样式表一个都不许被禁用、浮层宿主必须是 `#se-root`、
控件配色仍必须是我们自己的令牌、必应选中浮窗必须被隐去。

还有一条**跨源共享**专项：用两个端口扮演两个源（端口也是源的一部分），
配一份可携带的存储桩模拟脚本级存储，断言 A 源配的规则
在 B 源能列出、能生效，且 B 源自身的 `localStorage` 始终为空 ——
证明规则确实走的是共享存储，而不是碰巧同源。

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
npm run verify:all              # 离线（浅色 + 深色）+ 实时，一次跑完
npm run verify:strip            # 离线快照，浅色
npm run verify:dark             # 离线快照，深色
npm run verify:live             # 实时站点，5 个查询词（需联网）
npm run verify:start            # 实时站点，按 document-start 注入
npm run verify:intl             # 实时站点，走代理打国际版（www.bing.com）
npm run verify:www4             # 实时站点，打备用入口 www4.bing.com（走代理）
npm run sample                  # 重新抓取离线快照
```

`verify:strip` 用抓取下来的 Bing 快照，不依赖网络，断言最细；
`verify:live` 连真实 Bing 跑多个查询词，用来发现线上结构变化。
两者互补。

**三个实时模式/开关值得单独说明**，它们各自覆盖一类真实故障：

- `--document-start` —— 用 `addInitScript` 注入，精确模拟 Tampermonkey 的
  `@run-at document-start`（脚本早于文档树执行）。必须跑这个模式：
  post-load 注入时 `document.head` / `body` 早已存在，
  测不出「文档树还没建立就去访问它」这类问题 —— 而线上正是这么挂的。
- `--proxy` —— 必应按 IP 分流：直连落到 `cn.bing.com`（中国版），
  经本机 7897 代理落到 `www.bing.com`（国际版）。
  国际版会多做一次 `rdr=1` 重定向，时序与国内版不同，历史上出过
  启动即崩、整个增强功能无反应的故障，因此国际版也要单独跑。
- `--host=<域名>` —— 换搜索入口，默认 `www.bing.com`。
  **测备用子域必须用这个开关**：默认的 www 测不出站点识别逻辑的漏洞，
  而 www4 当初正是因为识别白名单里没有它，导致脚本静默退出、
  整个增强都不生效。每个入口各用一份独立的配置目录，
  免得 Cookie 互相干扰地区判定。

两个开关可以叠加（`npm run verify:intl` 就是「国际版 + document-start」）。

所有验证脚本统一在本机 **Chromite** 中运行，
路径与启动方式收敛在 `scripts/lib/browser.mjs`，改浏览器只需改这一处。

实时验证用**持久化配置目录**（`.build/chromite-profile`）：
默认的临时 profile 每次都是「新访客」，而 Bing 对首次访问会做一次
带 `rdr=1` 的重定向，把已重写好的 DOM 整个冲掉。保留 Cookie 后
即表现为回访用户，与真实使用一致。需要干净的初次访问时删掉该目录即可。

### 下一步

手机端（真机）方向：点击目标尺寸（菜单按钮实测 27×19px，远低于 44×44）、
`@media (hover: hover)` 门控（现有 16 条 `:hover` 在触屏上会「粘住」）、
以及一条真正的移动模拟验证（移动 UA + 触屏 + 带 viewport meta 的页面）。

精修方向：字距与比例微调、中文排版优化、favicon 提取、
搜索结果高亮关键词、宽屏多列布局等。

过滤功能后续可做：按标题/摘要关键词过滤（不止域名）、
规则的导入导出、命中规则时的数量提示。

## 说明

- 打包产物通过 `banner` 注入 `==UserScript==` 头，版本号从 `package.json` 读取，**改版本只需改 `package.json`**。
- GM API 不可用时会自动回退：样式改插原生 `<style>`，
  过滤规则改读写 `localStorage`，都不报错（控制台调试、验证脚本走的就是这条路径）。
- 需要远程接口时记得在 `meta.ts` 的 `GRANTS` 里补 `@connect`。

## License

MIT

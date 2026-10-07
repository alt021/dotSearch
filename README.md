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

`meta.ts` 里正式版的 `@updateURL` / `@downloadURL` 指向
`raw.githubusercontent.com/alt021/search-enhance/main/dist/search-enhance.user.js`。
配好之后，Tampermonkey 会自动检查并升级，用户侧只需打开那个 URL 首次安装。

> **注意**：仓库当前**不提交 `dist/`**（它属于生成物，见上表）。
> 因此上面那个地址目前取不到文件，方式 C 要等下面任一件事做完才可用：
>
> - 加一个 CI（如 GitHub Actions）在推送时构建并发布产物；
> - 或改主意把 `dist/search-enhance.user.js` 纳入版本控制；
> - 或把构建产物挂到 Release，让 `@updateURL` 指向 Release 资产地址。

---

## 验证是否生效

装好后按以下顺序检查：

1. 打开 <https://www.bing.com/search?q=test>，页面应只剩搜索框与结果列表
2. 顶栏、页脚、侧栏、广告、Copilot 面板应全部消失
3. 页头「BING — 检索」那一行的末尾有 **菜单** 按钮，点开可见 **结果过滤设置**
   （本脚本自己的功能，排在第一位）、账户入口
   （未登录显示「点击登录 Bing」，已登录显示「已作为 X 登录」）、
   Microsoft Rewards 与搜索设置
4. 结果链接应指向**真实站点地址**（而非 `bing.com/ck/a` 中转），点击在新标签打开
5. 页面 DOM 应大幅缩减（实测 378 → 56 节点）
6. 在「结果过滤设置」里加一条 `csdn.net` → 选「隐藏该结果」，
   对应条目应立即变为灰字占位，单击可正常恢复

排查：在控制台执行 `window.__searchEnhanceDebug__ = true` 后刷新，
即可看到 `[search-enhance]` 开头的 info 级日志；
关键诊断（如重写完成、分页缺失）一律以 `console.warn` 输出，无需开关即可见。

---

## 与东方永页机（Pagetual）协同

本脚本重写页面时会**保留必应原始 DOM**（移入隐藏容器 `#se-source`，
不可见也不占位），而不是删除它 ——
因为自动翻页脚本是「自驱动」的：它要靠当前页的结构去定位
「下一页链接」与「主内容容器」。删掉这些锚点，它就无从下手。

保留之后，永页机照常抓取并在隐藏容器里插入新一页的结果；
本脚本监听它的 `postMessage`（`insert` / `lastPage`）并配合
`MutationObserver`，把新结果**按本页样式追加到列表末尾**，
页头的结果计数也会同步更新。

### 如果自动识别不生效

永页机的自动识别是启发式的，可能挑不到正确节点。
本项目提供了一份显式规则，导入后即可确定下来：

`docs/pagetualRule.json`

```json
[
  {
    "name": "必应 + 搜索体验增强",
    "author": "search-enhance",
    "example": "https://www.bing.com/search?q=test",
    "url": "^https?://(www|cn)\\.bing\\.com/search",
    "nextLink": "#se-source .sb_pagN, #se-source .sb_pagNext, #se-source a[aria-label=\"下一页\"]",
    "pageElement": "#b_results"
  }
]
```

导入方式：永页机设置页 → 规则 → 导入上述 JSON。

### 已知限制

- 永页机若配置为 iframe 模式（规则里的 `action` 为 1 或 2），
  新页内容会以 iframe 呈现，本脚本无法把它接进列表。
  默认的「抓取静态 HTML 后插入」模式不受影响。
- 协同生效后，页面的页码导航仍然保留，两种翻页方式并存。


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
├── meta.ts                  单一元信息来源（@match / @grant / 版本头）
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
│   ├── bing.ts              ✅ 已接入
│   ├── google.ts            ⏸ 预留
│   └── baidu.ts             ⏸ 预留
├── features/
│   ├── index.ts             功能注册表（顺序即执行顺序）
│   ├── strip-to-results.ts  结果页重写：重建页面 + 保留隐藏数据源 + 过滤落点
│   ├── bing-session.ts      登录状态采集（须在清空前调用）
│   ├── tool-menu.ts         页头「菜单」按钮与弹出面板
│   ├── filter-store.ts      结果过滤规则存储（GM 脚本级存储，跨源共享）
│   ├── filter-panel.ts      结果过滤设置浮层
│   └── pagetual-bridge.ts   永页机协同：把新加载的内容接进列表
└── styles/base.css           重建后的基础样式

scripts/
├── lib/browser.mjs           测试浏览器入口（统一指向本机 Chromite）
├── build.mjs                 esbuild 打包（支持 --dev / --watch / --minify）
├── serve.mjs                 本地静态服务，供 Tampermonkey 以 URL 安装
├── fetch-sample.mjs          抓取真实 Bing 结果页快照
├── verify-strip.mjs          离线快照验证（不依赖网络，深度断言）
├── verify-live.mjs           实时站点验证（真实 Bing，多查询词）
└── check-underline.mjs       菜单文字下划线目视校验（需人工看截图）
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

所有功能常驻启用 —— 原先的开关机制（Tampermonkey 菜单）已移除。

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

实测（真实 Bing 快照 + 本机 Chromite）：DOM **378 → 56 节点**，10 条结果全保留，
原站元素与 `li.b_algo` 残留均为 0，跳转链接残留 0。

### 已实现：结果过滤（`filter-store` + `filter-panel`）

从页头「菜单 → 结果过滤设置」打开的浮层里，按**域名**配置处理方式：

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
  这是**用户级**偏好，要跨会话保留；与 `bing-session` 的登录状态
  （页面级、存 `sessionStorage`）不是一回事。
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
npm run sample                  # 重新抓取离线快照
```

`verify:strip` 用抓取下来的 Bing 快照，不依赖网络，断言最细；
`verify:live` 连真实 Bing 跑多个查询词，用来发现线上结构变化。
两者互补。

**两个实时模式值得单独说明**，它们各自覆盖一类真实故障：

- `--document-start` —— 用 `addInitScript` 注入，精确模拟 Tampermonkey 的
  `@run-at document-start`（脚本早于文档树执行）。必须跑这个模式：
  post-load 注入时 `document.head` / `body` 早已存在，
  测不出「文档树还没建立就去访问它」这类问题 —— 而线上正是这么挂的。
- `--proxy` —— 必应按 IP 分流：直连落到 `cn.bing.com`（中国版），
  经本机 7897 代理落到 `www.bing.com`（国际版）。
  国际版会多做一次 `rdr=1` 重定向，时序与国内版不同，历史上出过
  启动即崩、整个增强功能无反应的故障，因此国际版也要单独跑。

两个开关可以叠加（`npm run verify:intl` 就是「国际版 + document-start」）。

所有验证脚本统一在本机 **Chromite** 中运行，
路径与启动方式收敛在 `scripts/lib/browser.mjs`，改浏览器只需改这一处。

实时验证用**持久化配置目录**（`.build/chromite-profile`）：
默认的临时 profile 每次都是「新访客」，而 Bing 对首次访问会做一次
带 `rdr=1` 的重定向，把已重写好的 DOM 整个冲掉。保留 Cookie 后
即表现为回访用户，与真实使用一致。需要干净的初次访问时删掉该目录即可。

### 下一步

精修方向：字距与比例微调、悬停动效、中文排版优化、favicon 提取、
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

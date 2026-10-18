# dotSearch 搜索优化脚本

全面增强Web搜索体验

# 主要功能

- 基于UserScript 各种浏览器全面兼容<sup>1</sup>
- 去广告去AI 直达搜索结果
- 重制大部分页面 增强视觉体验
- 支持隐藏或标记特定网站结果
- 增强深色模式支持
- 兼容第三方拼页插件<sup>2</sup>
- 保留源搜索引擎大部分附加功能<sup>3</sup>
- 手机端单独适配：收紧两侧留白，分页简化为 PREV / NEXT

# 按引擎分开发布

每个搜索引擎是一个**独立脚本**，可同时安装、互不干扰：

| 脚本 | 状态 |
| --- | --- |
| `dotSearch-bing.user.js`（dotSearch for Bing） | 可用 |
| `dotSearch-google.user.js` | 适配中 |
| `dotSearch-baidu.user.js` | 适配中 |

# 特别提醒

本项目为Vibe Coding产物，仅供作者自用，代码质量较差。如有需要请自行重构或修改

# 安装

正式版本仍在筹备中 您可前往`GitHub Release`获取预览版本

安装 `dotSearch-bing.user.js` 即可。**产物名已由 `dotSearch.user.js` 改为
`dotSearch-bing.user.js`**，此前装过旧脚本的请卸载后重新安装一次。

建议使用**Tampermonkey**安装此脚本，**通过其他脚本管理器加载此脚本遇到的问题不予回应**

**预览版本不支持自动更新 请前往当前仓库进行更新**

---

[1] 桌面端针对横屏优化；手机端已单独适配（收紧留白、内容顶格、分页改为 PREV / NEXT），但版式与桌面保持一致

[2] 仅东方永页机已经过测试并完美支持，若需兼容其他第三方插件请通过GitHub Issues反馈

[3] 受技术限制，部分功能仅可做到保留入口，无法完全还原体验

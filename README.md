<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon/lockup-dark.svg">
    <img src="assets/icon/lockup.svg" width="260" alt="dotSearch">
  </picture>
</p>

全面增强Web搜索体验

# 主要功能

- 基于UserScript 各种浏览器全面兼容<sup>1</sup>
- 去广告去AI 直达搜索结果
- 重制大部分页面 增强视觉体验
- 支持隐藏或标记特定网站结果
- 增强深色模式支持
- 自带连续加载<sup>2</sup>：SHOW MORE 或滚动自动加载，每次检索最多 100 条
- 保留源搜索引擎大部分附加功能<sup>3</sup>

# 特别提醒

本项目为Vibe Coding产物，仅供作者自用，代码质量较差。如有需要请自行重构或修改

# 安装

正式版本仍在筹备中 您可前往`GitHub Release`获取预览版本

建议使用**Tampermonkey**安装此脚本，**通过其他脚本管理器加载此脚本遇到的问题不予回应**

**预览版本仅支持Bing搜索且无法自动更新 请在当前仓库进行更新**

---

[1] 脚本目前仅支持桌面浏览器；移动设备不在支持范围内，界面不会针对窄屏做适配。

[2] 结果列表末尾的 SHOW MORE 每次追加 10 条，地址栏不变；自动加载可在「菜单 → 附加设置」中开启。
两项合计每次检索最多加载 100 条。东方永页机与本脚本的拼页会相互冲突，检测到时会自动停用它。

[3] 受技术限制，部分功能仅可做到保留入口，无法完全还原体验

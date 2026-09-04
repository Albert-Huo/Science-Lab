# 微信滚动手柄兼容 Implementation Plan

**Goal:** 在微信 X5/WKWebView 中为右侧内容滚动手柄提供可靠的触摸回退。

**Architecture:** 在既有 `bindBand` 内统一 pointer/touch 手势状态。Touch Events 只绑定手柄并优先接管真实触摸，避免改变实验区输入。

## 步骤

- [ ] 增加指针捕获失败仍可移动的失败测试。
- [ ] 增加纯 Touch Events 滚动和 pointer/touch 去重的失败测试。
- [ ] 修改 `experiment-scroll.js`，实现统一手势、非被动触摸监听与确定性清理。
- [ ] 更新预览说明和交付记录。
- [ ] 运行滚动专项、完整测试、语法与差异检查。
- [ ] 使用隔离浏览器模拟微信触摸环境，验证拖动、横滑、轻点和实验编号不变。
- [ ] 提供本地 HTTP 预览，等待真实微信确认；不推送或部署。

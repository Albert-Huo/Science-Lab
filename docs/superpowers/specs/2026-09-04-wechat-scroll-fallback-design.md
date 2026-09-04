# 微信内置浏览器滚动手柄兼容设计

日期：2026-09-04

## 已确认边界

- 微信中能看到右侧手柄，说明新版页面已加载、宿主与实验 iframe 已完成可信握手、当前内容存在溢出。
- 故障位于手柄输入层。现实现只监听 Pointer Events，并在 `setPointerCapture` 抛错时直接放弃手势；部分微信 X5/WKWebView 对指针捕获支持不稳定。

## 设计

- 保留 Pointer Events 作为鼠标、触控笔和正常浏览器的主路径。
- 指针捕获失败时保留当前手势，不再直接终止；手柄区域内继续接收事件。
- 仅在 `#scrollHandle` 上增加非被动的 `touchstart`、`touchmove`、`touchend`、`touchcancel` 回退。
- 真实触摸事件到达时接管同一次触摸产生的 pointer 手势；后续 pointer 事件忽略，避免一次移动滚动两次。
- 沿用 8px 轴锁、4096px 单次上限、状态校验和取消清理。轻点、横滑、第二根手指均不滚动。
- 不在 document、window 或实验 iframe 上添加触摸监听，不改变器材拖动和浏览器缩放区域。

## 验收

- 指针捕获抛错后，元素仍收到的 pointermove 可以滚动且不抛出异常。
- 没有 Pointer Events 时，单指 Touch Events 可以滚动；结束/取消后不再响应。
- 同一次触摸同时产生 pointer 与 touch 事件时只滚动一次。
- 现有纵向、横向、轻点、键盘、滚轮、安全通信测试全部保持通过。
- 本地模拟微信 User-Agent 和触摸上下文通过后提供预览；不提交、推送或部署，等待真实微信验收。

## 后续生命周期修订（v0.8.5 / receiver v2）

真机继续出现“手柄可见但不滚动”后，已证明“可见即握手有效”这一早期判断不完整：实验 iframe 在 `pagehide` 时会断开接收器，但宿主仍可能保留最后一次状态并继续显示手柄。

- 接收器在可恢复的 `pagehide` / `freeze` 阶段暂停监听但保留已验证会话，并在 `pageshow` / `resume` 时恢复和重新上报。
- 宿主在重新可见、`pageshow` 或 `resume` 时重新激活当前 iframe；正常 `pagehide` 仍取消手势并断开。
- 每次有效拖动开始时，宿主以当前会话重发一次 `connect`，即使 WebView 漏掉恢复事件，下一次拖动也可自愈。
- Android 返回手势来自屏幕左右边缘，因此透明触摸带从最右边缘向内移 18px，并继续叠加 `safe-area-inset-right`；可见短条尺寸不变。
- 内容接收器升级为 `experiment-scroll-receiver.v2.js`，70 个初中物理实验只替换统一引用行；保留 v1 文件兼容旧缓存。宿主滚动脚本与 Service Worker 同步升级至 v0.8.5。

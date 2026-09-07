# 电脑端目录收起与展开

目标：用户反馈电脑网页版左侧目录无法收起，为宽屏目录加入可发现的收起/展开操作，沿用本任务已授权的提交、推送和上线流程。

原因：原来的 900px 宽屏布局强制目录常驻，并隐藏关闭按钮与顶部目录按钮。

设计：目录标题旁“收起”，隐藏后顶部左侧显示“展开目录”；隐藏目录释放 300px，实验 iframe 可使用完整宽度。只调整布局，不重建 iframe。通过现有安全存储辅助函数记住本机选择；移动端继续显示右侧抽屉，跨断点不丢失桌面偏好。隐藏目录不参与键盘导航，按钮同步 aria-expanded 并恢复焦点。

- [x] 在 index.html 添加目录收起、展开、宽屏布局与偏好保存。
- [x] 同步 App、滚动模块、缓存及现有版本断言至 v0.8.7，补充 README。
- [x] 验证桌面展开/收起、刷新保持、当前 iframe 与实验编号保持、窗口跨断点、手机目录和存储不可用降级。
- [x] 运行现有回归检查，提交推送本次改动。
- [x] 沿用静态原子发布流程上线，校验正式站及保留回滚目标。

文件：index.html、sw.js、experiment-scroll.js（版本标识）、server/api/test/frontend-scroll.js（版本断言）、server/api/test/frontend-catalog-control.js（补齐已发布赞赏码的静态清单断言）、README.md、本记录。

验证命令：`git diff --check`、`node server/api/test/frontend-storage.js`、`node server/api/test/frontend-scroll.js`、`npm test --prefix server/api`。浏览器使用本任务专属无头会话 `task-91d7c2`，完成后关闭。

## 发布前验证

- 完整 `npm test --prefix server/api` 通过。首次运行发现既有发布契约断言漏列赞赏码图片；与上线文档核对后补齐，再跑全套通过。
- 独立无头浏览器：1440×900 下目录收起前 feed 左偏移为 300px，收起后为 0，iframe 宽度为 1440px；iframe DOM 与当前编号不变。展开/收起均可在刷新后保持；键盘 Enter、焦点恢复和 aria-expanded 正常。
- 390×844 下抽屉打开和关闭正常，跨桌面断点关闭遮罩且保留桌面收起偏好；收起时仍可打开“我的”。禁止 localStorage 读写时，收起与展开仍可操作。
- 视觉检查：`output/playwright/collapsible-catalog/` 下桌面展开、桌面收起和移动目录截图均已检查；截图不纳入发布。
- 独立代码审查无 Critical / Important 问题。记录一个不阻断本次正常目录发布的既有初始化边界：空实验清单会提前返回，目录布局按钮未绑定。后续处理空清单交互时应将布局控制独立初始化；本次不扩展重构范围。

## 上线记录

- 版本：v0.8.7；发布代码：`662dbe1f369d5d01a89a40c85bcc7110ab043e9c`，已推送 origin/main。
- 线上静态 release：`/var/www/science-lab-releases/20260907-662dbe1f369d`。
- 回滚目标：`/var/www/science-lab-releases/20260907-f4ee2f9273cd`，已保留在 previous 链接。
- 从已提交源码打包 13 个静态文件，切换前和切换后逐文件 SHA-256 校验通过。公网首页、版本化滚动模块、二维码均 200 且字节一致，未知 JSON 返回 404，API 健康检查正常。
- 后台 release、进程 PID 468357、Nginx 和 systemd 配置摘要均保持不变；本次没有服务重启。
- 正式站隔离浏览器复测通过：桌面收起/展开、1440px 完整宽度、iframe 与实验编号不变、刷新保留偏好、手机抽屉；收款方文本和 1141px 原始二维码正常。另验证移动搜索框聚焦后跨断点，焦点回到展开按钮。

# 自动访问分类上线验收

2026-09-14 11:02北京时间按用户授权完成提交、推送与部署。代码提交`5d6a581b16c61d20c9d7746abcd683a87229f89e`，已快进合并至main并推送origin；发布包SHA-256为`53eb3b63e49bc9ed15cb87e8e8148fa883cdd6320e4fb9dbb9c19fe9caefca31`，本机/远端一致，13个运行文件逐项cmp一致。

## 用户可见变化

- [访问观察台](https://lab.xingnian.net.cn/admin/traffic/)新增已验证爬虫、高置信自动特征、疑似自动访问、未命中规则四类互斥统计；只优化统计，不封禁。
- 保留原入口与IP+UA组合估算，明确不是人数；另显示“未标记入口”，也不能当作真人。
- 展开显示本期原因计数、规则ID/阈值及局限；Google/Bing分别显示官方清单状态与更新时间。
- 默认小时趋势为未标记入口，可切换原始流量及自动类别；小时明细与当前/历史CSV同步分类，旧历史未知留空。
- 无新增付费服务、浏览器追踪、模型调用；公开页面、AI配额、API服务与Nginx访问控制未改。

## 代码与文件

| 范围 | 文件 |
| --- | --- |
| 判定与官方来源 | `tools/traffic-automation.cjs`、`tools/traffic-bot-ranges.cjs` |
| 统计与有界输入 | `tools/traffic-dashboard.cjs`、`tools/traffic-report.cjs` |
| 页面、趋势、CSV | `tools/traffic-dashboard-view.cjs`、`tools/traffic-dashboard-client.js`、`tools/traffic-dashboard-automation.css` |
| 定时任务 | `server/traffic/science-lab-bot-ranges.service/.timer`、`science-lab-traffic.service`、`science-lab-traffic-observability.conf` |
| 回归 | `server/api/test/traffic-automation.js`、`traffic-dashboard.js`、`traffic-dashboard-view.js`、`ai-stream-outcomes.js`、`server/api/package.json` |
| 设计与维护 | `server/traffic/README.md`、`docs/superpowers/specs/2026-09-14-traffic-automation-design.md`、`docs/superpowers/plans/2026-09-14-traffic-automation.md`、本记录 |

独立复审发现并修复：全局分钟/时间样本/字符串与扫描行预算、短URI底层滞留完整查询串、日级空日志覆盖历史、UA设备词片段误判及明确工具/爬虫产品token漏判。只修正旧事件测试等待换行完成记录的竞态，不放宽生产日志解析。

## 回归与影子生成

`node --test server/api/test/traffic*.js`63/63通过；`git diff --check`通过。Linux隔离目录完整`npm test`退出0，复用已安装Node22/Python3.9，仅任务PATH选用Python3.9，不修改系统Python。最终观测43项中42通过、1项因独立redis-server不可用按条件跳过；生产Redis/额度任务未改。未调用付费模型。

真实日志旧/新生成器所有原始totals与24小时字段逐项deepEqual成功。影子运行0.75秒、max RSS91972KB，低于原报表128MiB/90秒限制；初次官方清单任务在64MiB/25秒实际sandbox内成功。

独立无头会话检查1440×1000桌面、390×844手机截图；手机整页scrollWidth=390，明细表322像素容器内局部滚动至900像素，不扩宽页面。分类趋势切换、判定规则展开、实际CSV下载通过（26行×77列）；任务浏览器和本地预览服务器已关闭。

## 部署与回退

生产备份为`/var/backups/science-lab/traffic-automation-20260914`，root:root、0700；备份统计代码、history.json、HTML、原报表service/drop-in与公开发布指针记录，不备份或输出API密钥。

暂停两小时timer并确认报表任务结束后部署；已有相同文件不重复覆盖，避免影响独立分钟额度任务。安装两个官方清单任务文件，通过systemd-analyze verify、daemon-reload后，先运行官方清单、再生成报表，随后启用每日timer、恢复两小时timer。无需重启API或reload Nginx。

两个oneshot均Result=success、ExecMainStatus=0；报表仍PrivateNetwork=yes、NoNewPrivileges=yes、MemoryMax=128MiB/90秒，更新器NoNewPrivileges=yes、64MiB/25秒。两小时timer下一次12:00；每日清单下一次2026-09-15 05:44:32北京时间。额度分钟timer、API服务均active。

公开API和静态发布指针仍分别为`/opt/science-lab-api-releases/20260910-51f5c6c`、`/var/www/science-lab-releases/20260910-51f5c6c`，首页本地文件散列与发布前完全一致。systemd verify出现既有额度任务BPF IP防火墙不受内核支持的已知警告；本次没有修改该任务，不将此警告解释为防火墙生效。

回退先停报表timer和新增每日timer，确认任务结束、备份最新状态，再成组恢复备份代码及原service/drop-in。若尚无新增归档，可恢复备份HTML/history；若已有新归档，保留最新历史不能覆盖丢失数据。原始日志与供应商公开清单不删除。具体操作边界见维护README。

## 线上验收

报告生成于2026-09-14 11:02:29北京时间，统计窗口09/13 10:00—09/14 10:00：全部1223、原始入口115、组合估算71、未标记入口113；已验证6、高置信635、疑似131、未命中451，合计1223。两家官方清单均有效，匿名AI未推断身份。

已认证HTML与quota.json均200/no-store；未认证二者均401。已认证访问history.json、bot-ranges.json和.env均404。公开首页与/api/health均200。CSP脚本散列正确，页面内嵌CSV序列化器与已提交代码精确一致，当前/历史CSV列数77且行数准确；全部/入口分类分区一致。

生产额度快照新鲜、Redis可读，全站上限500、并发上限10均未改变。验证仅输出匿名汇总，不保存或展示认证信息、原始IP、UA或用户正文。

# AutoReply

用于店铺运营的浏览器侧边栏插件。读取未回复评价，按单款商品资料生成并公开发布符合规则的回复，特殊评价交给人工。当前版本 **0.10.2**。

插件使用原生 HTML、CSS 和模块化 JavaScript，无框架或构建服务。私有规则和模型调用在 Windows 配套组件中执行，通过 Native Messaging 自动连接。

## 安装与使用

下载并保留 `AutoReply-Install.exe`，以后双击同一个文件即可安装或更新。它会从 GitHub 获取最新正式版，核对安装包的 SHA-256，再按本机情况提供首次安装、更新或修复。 [下载统一安装器](https://github.com/kyle-1227/AutoReply/releases/latest/download/AutoReply-Install.exe)

需要离线安装或安装指定版本时，可使用 `AutoReply-Setup-0.10.2-win-x64.exe`。安装包已附带同版本扩展，`autoreply-extension-v0.10.2.zip` 可用于独立分发扩展。 [v0.10.2 发布附件](https://github.com/kyle-1227/AutoReply/releases/tag/v0.10.2)

本机交付同时提供中文安装说明、CURRENT.json 和 SHA256SUMS.txt，便于核对版本、文件大小及 SHA-256。旧包保留在 `releases/archive`；历史发布版本可从 [GitHub Releases](https://github.com/kyle-1227/AutoReply/releases) 查看。

1. 每台 Windows 10／11 x64 电脑的使用账号安装一次 AutoReply-Setup-0.10.2-win-x64.exe。API Key 可在安装向导填写，也可留空后在插件“模型账户”填写。内置 Node.js 24.14.0，无需另装运行时。
2. Chrome／Edge 在扩展管理页开启开发者模式，加载直接包含 manifest.json 的文件夹：源码或安装目录中的 extension，或插件 ZIP 的解压目录。
3. 打开 TikTok Shop MY／SG 商品评分页，点击 AutoReply，读取未回复并维护本店商品资料，再点击“开始生成并发布”。插件会逐条公开发布模型判定可回复的评价。

默认组件目录为 %LocalAppData%\AutoReply，向导可选择其他目录。组件与源码路径独立，首次安装步骤见根目录 [安装说明](安装说明.md)。正式版沿原扩展条目更新，资料自动保留和转换，不需要迁移包。

首页右上角的“版本更新”显示插件、组件和最新正式版，支持“检查更新”和“一键更新”。组件从固定 GitHub Release 下载并校验配套安装包，统一保存并暂停相关环境后安装。Chrome／Edge 重载插件，BitBrowser 通过本机 Local API 仅重开相关环境；任务保持暂停，等待手动继续。远端落后时不会降级，安装或健康检查失败会回滚，运行核验未完成时不会显示全部成功。

首次需手动安装本版组件，再从安装目录加载插件，或在 BitBrowser 扩展中心添加该本地目录。旧组件没有更新能力，源码开发目录不会被覆盖。BitBrowser 连接设置位于版本弹窗，认证信息由组件使用 DPAPI 加密保存；其他电脑分别更新。完整步骤见根目录安装说明。

文本／图片默认使用 anthropic/claude-haiku-5.5，含视频评价先使用 meta/muse-spark-1.3-contributor。视频模型发生端点、网络、超时或格式错误时，立即回退一次 Haiku：只保留文字和已有图片，明确标记视频未识别，不抽帧或处理音频。每阶段最多一次请求、各 25 秒；纯视频失败直接转人工，正常转人工不触发回退。

两阶段技术失败时，该条标为“生成失败”，后续评价继续。失败区支持逐条或全部重试、转人工和移除；自动重读只刷新内容，不自动重试。没有待处理但仍有失败时显示“本轮结束 · 有失败”并释放窗口，失败不算已处理。Haiku 限流、凭据／余额／权限、费用存储、组件断开及明确模型拒绝仍暂停任务。视频端点限流可立即尝试 Haiku，不沿用视频端点等待时间。

源码中的 Haiku 使用 `low`、`max_tokens: 2048` 和严格 JSON Schema，并执行本地输出校验。业务规则先区分当前问题、已解决历史和其他商家的经历，再判断售后、安全、商品故障或资料不足；商品破损仅在 4–5 星、明确接受且没有优先人工条件时允许自动回复。公开回复最多 300 个 UTF-16 代码单元。

源码 Prompt 已升级为 **v4.1 全品类规则**：固定基础规则＋最多一份当前商品的类目补充规则＋单款商品资料。产品资料页的“店铺类目”可多选或跳过，每款商品可独立指定主要类目。商品明确分类优先；未分类或未匹配商品时，店铺只有一个类目就使用它，否则仅用基础规则。“其他商品”始终只用基础规则。不增加模型分类调用，不把本店全部类目发送给每条评价。

插件和本机组件须使用同一软件版本；握手会明确显示版本差异并阻止混用。Prompt 独立保持 v4.1，费用与类目能力版本独立校验。完整规则见 [v4.1 中文稿](server/prompts.zh-CN.md)，正式英文实现见 server/prompt-rules.js。

## 数据与任务

- 真实生成按平台商品 ID 集中处理，同商品不同 SKU 属于同组，组内保持首次入队顺序。当前组做完再切换下一组，页面剩余队列与执行顺序一致；暂停恢复优先处理被中断的评价。每次模型请求仍只包含一条买家评价。
- 平台总数与实际列表不一致时，完整遍历全部页后导入去重后的有效评价，同时显示实际读取数、平台总数和差异提醒。处理结束只表示已读取评价处理完毕，数量仍待核对；翻页提前停止或请求失败仍报错，不作为成功读取。
- 商品资料属于当前 BitBrowser 店铺环境，按平台、站点和店铺长期独立保存。组件没有商品数据库；不同店铺逐一维护，同款多链接／SKU 使用同一档案。
- 活动任务锁定本店资料及类目；暂停且同店铺没有其他活动任务时可编辑，继续使用新版本。外部恢复改变商品或类目时暂停确认。商品及经营类目随 v2 资料备份导出，新版仍接受 v1 备份；旧资料默认未分类。
- 开始后绑定原评价标签页，挂起、关闭侧边栏、切页后继续。同窗口最多一个任务，不同窗口可并行。立即暂停拒绝迟到结果。原标签页换网址时保留任务并等待返回，回到原评价页后手动继续；关闭来源页或窗口、移出原窗口仍结束任务。
- 平台确认提交成功后计入“已发布”。提交结果不明时保留正文，标记“发布待核对”并暂停。历史“已生成 · 待确认”仍可在详情查看，发布由运营人员处理。
- 组件断开取消当前工作并暂停；恢复连接本身不重做评价。浏览器重启后，未完成生成等待人工确认目标页后继续。
- 完成／结束任务与闲置草稿 24 小时后清理，暂停记录及仍有失败的任务保留；失败全部解决、转人工或移除后恢复正常保留规则。组件任务只在内存中，退出即清空。
- Key 可由安装向导或插件“模型账户”填写，使用 Windows 当前用户 DPAPI 加密保存。插件只接收配置状态，不持久保存 Key；各本机组件进程在新调用前检查凭据变化。插件 ZIP 不含业务 Prompt；配套组件中包含规则代码。

任务页进度条下显示“本次任务费用”和“本店累计费用”，使用美元六位小数；请求未结束显示“计费中”，账单无法确认则保留“待确认”及笔数。费用来自 OpenRouter 实际账单，包含重试、模型转人工和输出校验失败的请求。清空记录只重置本次计费轮次，店铺累计保留，暂停后的迟到费用仍计入原轮次与原店铺。

费用从首次连接支持采集的本机组件时开始记录，不回填旧任务。仅重新加载插件不能更新已安装组件；更新须覆盖原组件目录并重新连接。费用口径及消息协议见 [评价接入约定](评价接入约定.md#api-费用统计)。

BitBrowser 两台电脑接手与扩展中心分发需单独验收，不能由单机自动连接推定成功。本地手动上传图片／视频当前用于演示与预览，真实生成媒体使用店铺读取的 HTTPS 地址。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| extension/background.js | 浏览器事件、消息、侧边栏与浮标协调 |
| extension/task-coordinator.js、task-runner.js | 页面归属、资料锁、队列、取消和恢复 |
| extension/review-queue.js | 商品分组、暂停游标和页面共用的待处理顺序 |
| extension/product-catalog.js、review-context.js | 资料校验／匹配和评价字段校验，组件复用同一实现 |
| extension/categories.js | 15 个公开经营大类、类目校验与唯一的选择优先级 |
| extension/workspace-store.js | 短期任务与草稿，不保存 Key 或连接设置 |
| extension/cost-store.js | 独立费用账本、计费轮次、店铺累计与美元格式化 |
| extension/panel.js、review-list.js、products.js | 面板操作、评价展示、商品资料编辑 |
| extension/native-client.js | 单一 Native Messaging 连接、握手和单条生成 |
| server/native-host.js、service.js、credentials.js | 二进制消息、临时任务、幂等、取消与本机凭据 |
| server/context.js、reply-generator.js、llm-*.js | 私有上下文、模型路由、输出校验与有限重试 |
| server/prompt-rules.js、prompts.zh-CN.md | v4.1 全品类基础规则、14 份类目补充规则及中文对照 |
| server/cost-tracker.js | 每次实际请求的费用通知、持久化确认及账单补查 |
| server/update-service.js、update-worker.js、releases.js | 跨进程更新协调、独立安装／回滚及正式发布校验 |
| extension/update-client.js、updates.js | 暂停确认、持久化重载标记和版本弹窗 |
| installer/ | 隐藏启动、DPAPI 凭据和 NSIS 安装／卸载 |
| scripts/ | 源码检查、正式 ZIP 和安装器构建 |

## 开发检查

运行 npm.cmd test、npm.cmd run check。打包命令为 npm.cmd run package、npm.cmd run package:installer，不需要 npm install。

软件版本唯一来源为 package.json。发布前运行 `npm.cmd run version:sync -- 新版本号`，自动同步扩展清单、共享运行版本和当前文档；检查与构建会拒绝版本漂移。组件握手、安装器、Windows 启动器文件版本及交付文件名使用同一软件版本。Prompt、数据格式、浏览器最低版本及 Node.js 版本分别维护。

运行 `npm.cmd run package:bootstrapper` 可构建固定入口 `releases/AutoReply-Install.exe`。正式发布时附上统一安装器、该版本的 Windows 安装包和 `CURRENT.json`。已分发的统一安装器会读取新的正式版本。

安装器构建需要 Windows .NET Framework 编译器和 NSIS 3.13，可通过 NSIS_EXE 指定编译器，也会检查系统安装目录和 %LocalAppData%\AutoReplyBuild\tools\nsis。Node 下载后校验固定 SHA-256。扩展身份由公开 manifest.key 固定，签名私钥不提交仓库。

tests/ 保存开发回归测试和历史评测资料，不随正式插件或本机组件打包。output/ 保存本机验证、历史测试归档和构建过程文件，releases/ 保存 EXE／ZIP，均不作为源码提交。交付文件通过 GitHub Releases 附件分发。仓库不再提供本机 HTTP 服务、商品数据库或手动连接令牌入口。

- [产品定位](PRODUCT_POSITIONING.md)
- [当前范围与待验收事项](项目需求文档.md)
- [字段与本机通信](评价接入约定.md)
- [安装说明](安装说明.md)

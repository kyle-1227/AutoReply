# AutoReply

用于店铺运营的浏览器侧边栏插件。读取未回复评价，按单款商品资料生成回复，并将特殊评价交给人工。当前版本 **0.5.0**，结果停留在“已生成 · 待确认”，尚未接入店铺发布。

插件使用原生 HTML、CSS 和模块化 JavaScript，无框架或构建服务。私有规则和模型调用在 Windows 配套组件中执行，通过 Native Messaging 自动连接。

## 安装与使用

1. 每台 Windows 10／11 x64 电脑的使用账号安装一次 AutoReply-Setup-0.5.0-win-x64.exe。API Key 可在安装向导填写，也可留空后在插件“模型账户”填写。内置 Node.js 24.14.0，无需另装运行时。
2. Chrome／Edge 在扩展管理页开启开发者模式，加载直接包含 manifest.json 的文件夹：源码或安装目录中的 extension，或插件 ZIP 的解压目录。
3. 打开 TikTok Shop MY／SG 商品评分页，点击 AutoReply，读取未回复、维护本店商品资料，再开始生成。

默认组件目录为 %LocalAppData%\AutoReply，向导可选择其他目录。组件与源码路径独立，首次安装步骤见根目录 [安装说明](安装说明.md)。从 0.7.0 正式版沿原扩展条目更新，资料自动保留和转换，不需要迁移包。

文本／图片默认使用 anthropic/claude-haiku-5.5，包含视频的整条评价使用 meta/muse-spark-1.3-contributor。

## 数据与任务

- 商品资料属于当前 BitBrowser 店铺环境，按平台、站点和店铺长期独立保存。组件没有商品数据库；不同店铺逐一维护，同款多链接／SKU 使用同一档案。
- 活动任务锁定本店资料；暂停且同店铺没有其他活动任务时可编辑，继续使用新版本。外部恢复改变资料时暂停确认。
- 开始后绑定原评价标签页，挂起、关闭侧边栏、切页后继续。同窗口最多一个任务，不同窗口可并行。立即暂停拒绝迟到结果，来源换网址或关闭则结束。
- 组件断开取消当前工作并暂停；恢复连接本身不重做评价。浏览器重启后，未完成生成等待人工确认目标页后继续。
- 完成／结束任务与闲置草稿 24 小时后清理，暂停记录保留；组件任务只在内存中，退出即清空。
- Key 可由安装向导或插件“模型账户”填写，使用 Windows 当前用户 DPAPI 加密保存。插件只接收配置状态，不持久保存 Key；各本机组件进程在新调用前检查凭据变化。插件 ZIP 不含业务 Prompt；配套组件中包含规则代码。

BitBrowser 两台电脑接手与扩展中心分发需单独验收，不能由单机自动连接推定成功。本地手动上传图片／视频当前用于演示与预览，真实生成媒体使用店铺读取的 HTTPS 地址。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| extension/background.js | 浏览器事件、消息、侧边栏与浮标协调 |
| extension/task-coordinator.js、task-runner.js | 页面归属、资料锁、队列、取消和恢复 |
| extension/product-catalog.js、review-context.js | 资料校验／匹配和评价字段校验，组件复用同一实现 |
| extension/workspace-store.js | 短期任务与草稿，不保存 Key 或连接设置 |
| extension/panel.js、review-list.js、products.js | 面板操作、评价展示、商品资料编辑 |
| extension/native-client.js | 单一 Native Messaging 连接、握手和单条生成 |
| server/native-host.js、service.js、credentials.js | 二进制消息、临时任务、幂等、取消与本机凭据 |
| server/context.js、reply-generator.js、llm-*.js | 私有上下文、模型路由、输出校验与有限重试 |
| installer/ | 隐藏启动、DPAPI 凭据和 NSIS 安装／卸载 |
| scripts/ | 源码检查、正式 ZIP 和安装器构建 |

## 开发检查

运行 npm.cmd test、npm.cmd run check。打包命令为 npm.cmd run package、npm.cmd run package:installer，不需要 npm install。

安装器构建需要 Windows .NET Framework 编译器和 NSIS 3.13，可通过 NSIS_EXE 指定编译器，也会检查系统安装目录和 %LocalAppData%\AutoReplyBuild\tools\nsis。Node 下载后校验固定 SHA-256。扩展身份由公开 manifest.key 固定，签名私钥不提交仓库。

output/ 保存本机验证和构建过程文件，releases/ 保存 EXE／ZIP，均不作为源码提交。仓库不再提供本机 HTTP 服务、商品数据库或手动连接令牌入口。

- [产品定位](PRODUCT_POSITIONING.md)
- [当前范围与待验收事项](项目需求文档.md)
- [字段与本机通信](评价接入约定.md)
- [安装说明](安装说明.md)

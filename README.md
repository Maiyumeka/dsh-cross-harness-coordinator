# DSH 跨 Harness 协调插件

在一个 DSH 会话里分配跨 Harness 工作，并由当前 Agent 审查真实产物。界面整合在 **设置 → 协调器**。

当前源码版本 **0.1.19**，固定验证宿主 **DSH 0.2.0-rc.2**，需要 Node.js 22 或更新版本。0.1.19 整理公开仓库、迁移路径和可复现测试；本机已安装的 0.1.18 不因本次发布自动更新。

## 功能

- text、ACP 和本机 MCP stdio 执行端；无需按品牌猜测能力。
- 复制邀请交给目标 Agent，插件完成连接验证；失败后 Agent 根据具体原因修正。
- ACP 检查 initialize/session/new；MCP 检查初始化、分页工具发现及明确任务映射。登记不调用模型任务。
- 依赖计划、同工作区串行写入、跨工作区并发 1–4、暂停及取消。
- 当前 Agent 读取真实产物，按版本和逐项条件审查，通过才释放下游；返工会使下游旧结果失效。
- 跨本机会话共享、登记会话移除、返工改派执行端、阻塞恢复、失败处理建议。

## 使用

通过 DSH 原生插件管理器安装本机构建的 tgz 包。详细步骤见 [安装与更新](AGENT_INSTALL.md)。安装和更新不要求退出 DSH，更新前检查任务空闲并备份。

在设置中复制邀请并亲自发送给目标 Agent。目标 Agent 负责识别实际入口和回传，用户无需手填技术参数。已有 MCP 服务器必须提供真实可调用的任务工具；参数由 Agent 根据工具的 inputSchema 整理。

接入成功后，在原会话中提出目标，由 Agent 规划、派发、读取和审查。登记成功、连接通过、任务交付和媒体理解分别记录，不能互相代替。

## 开发与构建

```sh
npm install
npm run build
npm pack --pack-destination dist
npm run release
npm test
```

必须先打包并生成发布清单，再运行完整核心测试；核心测试包含包内容和源码哈希核对。依赖 DSH 的固定版本 SDK；深测还需要浏览器或隔离 DSH 测试环境。

`npm run preview` 使用已准备好的隔离演示数据（test-data/native-home/coordinator/state.json）；`npm test -- --deep` 追加深测。缺少所需环境会明确报告跳过。默认核心测试使用本地测试进程及宿主文件夹具，不读取或修改正式 DSH 数据。

发布清单生成器可通过 DSH_HOME、COORDINATOR_DSH_PROFILE、COORDINATOR_DSH_CLI、COORDINATOR_DSH_ASAR 适配本机。开发机可以使用忽略的 .local-install.json 保存路径；不得放入密钥。

## 边界

MCP 只支持本机 stdio 和传统初始化生命周期版本2025-11-25、2025-06-18、2025-03-26、2024-11-05；不支持 HTTP/SSE 直连、OAuth、现代无初始化生命周期或必须异步 task 的工具。JSON Schema 支持2020-12及显式 draft-07，不加载外部引用。

产物哈希上限64MiB，工具读取及预览上限10MiB。媒体预览和文件哈希不证明模型已理解内容；没有实际检查能力时必须报告 unverified。进程沿用宿主沙箱，不自动批准额外权限。暂停不证明远端任务或计费已经撤回。

新会话首次读取共享执行端、共享撤回后的排队任务授权，以及部分历史事件重放仍需要进一步验证。GitHub 地址直接安装和自动发现新版尚未实现。

## 仓库内容

[架构与开发交接](docs/ARCHITECTURE.md) · [通用接入说明](lib/接入说明.md) · [安装指南](AGENT_INSTALL.md)

本机交接快照、邀请资料、正式数据、测试产物、备份及依赖不进入 Git 历史。许可证沿用 package.json 的 MIT 声明。

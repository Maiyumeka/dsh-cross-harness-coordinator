# 架构与公开交接

这是0.2.3公开源码交接；本机原始交接和状态快照保留在忽略的 docs/local-handoff，不公开。最新缺陷处理见 [修复记录](修复记录-0.2.3.md)。

| 文件 | 职责 |
|---|---|
| lib/index.js | DSH插件、七个Agent工具、宿主启动、设置RPC及邀请回传 |
| lib/engine.js | 持久化、依赖派发、产物版本、审查、返工与恢复 |
| lib/fingerprints.js / version-probe.js | 指纹差异和确认绑定、同启动入口的无任务版本取证 |
| lib/runner.js | text/ACP适配与统一协议分流 |
| lib/bridges.js | 入口验证、协议检查回执与外部SDK启动指纹 |
| lib/mcp.js / mcp-network.mjs | MCP传统与现代生命周期、工具映射及stdio/HTTP/SSE |
| lib/native.js / rpc.js | Codex App Server与结构化CLI，有界消息及终态关联 |
| lib/remote.js / worker.mjs / network.js | 宿主沙箱工作进程、A2A/OpenCode/WebSocket与认证引用 |
| lib/claude-worker.mjs / claude-worker.py | 已安装Claude Node/Python SDK初始化、任务和取消 |
| lib/delivery.js | 远端声明文件交付、边界及内容限制 |
| lib/onboarding.js | 有效期、一次性邀请及一次修正回传 |
| lib/client.js | 设置界面和当前主会话绑定 |
| scripts/agent-install.mjs | 发布包校验、空闲检查、备份和安装验证 |

执行端必须由用户邀请接入。候选能力是申报；当前Agent负责模型选择、真实产物读取和逐项审查。未知能力、费用或额度保持未知。

协议流程见 [桥接说明](BRIDGES.md)。登记统一由插件先做无任务检查，不提交模型任务；失败后 Agent 修正一次。MCP派发前重新发现并核对映射，Codex关联thread/turn，A2A关联task。远端产物必须实际交付，全部协议仍经过同一当前Agent审查流程。

同一工作区只有一个写入执行任务。前置产物变更或返工使后续旧结果失效；恢复先核对文件和日志，不盲目重做。使用工具或设置RPC，不在运行时编辑 state.json。

当前工具：coordinator_candidates、coordinator_status、coordinator_plan、coordinator_read、coordinator_review、coordinator_control、coordinator_wait。connect只检查或修正已有本会话执行端，不能自报握手通过。reconfirm先查看差异，绑定confirmation_version并填写依据才更新基线；允许保留已通过任务。cancel可带id只结束一项；未带id保持会话级语义。rework可改派实际可见执行端。

close带id将已完成任务移到历史。状态查询把当前tasks和closedTasks分开，内部依赖图保留原任务；关闭不改动passed状态、原结果、审查或文件。guard只跟踪当前任务及其前置，仍被使用的历史前置变化会恢复到当前列表处理；无引用的已结束历史不会触发自动执行。新计划仍将旧记录保存到previousPlans。

默认测试覆盖核心引擎、产物保护、阻塞恢复、协议接入、大启动文件和发布校验。mainstream.mjs使用官方A2A SDK三种传输、本地MCP HTTP/SSE、Codex stdio/WebSocket、假Claude SDK和结构化CLI；Python夹具需COORDINATOR_TEST_PYTHON。深测依赖独立DSH环境。真实媒体、账户额度、正式进程树和远端停止需要单独证据，不能用夹具验收替代。

# 架构与公开交接

这是0.1.19公开源码交接；本机原始交接和状态快照保留在忽略的 docs/local-handoff，不公开。

| 文件 | 职责 |
|---|---|
| lib/index.js | DSH插件、七个Agent工具、宿主启动、设置RPC及邀请回传 |
| lib/engine.js | 持久化、依赖派发、产物版本、审查、返工与恢复 |
| lib/runner.js | text/ACP适配及MCP分流 |
| lib/mcp.js | MCP stdio握手、工具映射、Schema校验、调用和取消 |
| lib/onboarding.js | 有效期、一次性邀请及一次修正回传 |
| lib/client.js | 设置界面和当前主会话绑定 |
| scripts/agent-install.mjs | 发布包校验、空闲检查、备份和安装验证 |

执行端必须由用户邀请接入。候选能力是申报；当前Agent负责模型选择、真实产物读取和逐项审查。未知能力、费用或额度保持未知。

协议流程：text单次输入；ACP初始化后创建会话并提交授权任务；MCP初始化后发现工具，在登记时验证明确映射，派发前重新发现并验证实际参数。登记时不调用任务工具。

同一工作区只有一个写入执行任务。前置产物变更或返工使后续旧结果失效；恢复先核对文件和日志，不盲目重做。使用工具或设置RPC，不在运行时编辑 state.json。

当前工具：coordinator_candidates、coordinator_status、coordinator_plan、coordinator_read、coordinator_review、coordinator_control、coordinator_wait。connect只检查或修正已有本会话执行端，不能自报握手通过。rework可改派实际可见执行端。

默认测试覆盖核心引擎、产物保护、阻塞恢复、ACP/MCP接入、大启动文件和发布校验；深测依赖独立DSH环境。真实媒体、正式进程树和远端停止需要单独证据，不能用夹具验收替代。

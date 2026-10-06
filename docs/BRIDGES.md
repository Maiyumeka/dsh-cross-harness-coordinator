# 主流桥接接口（0.2.0）

目标 Agent 根据实际入口选择协议并回传定义，用户只需要发送邀请。登记由插件先检查，失败后 Agent 按证据修正一次。登记检查不提交模型任务；模型目录、账户额度、执行成功和产物审查分别记录。

| protocol | 已实现的入口 | 登记检查 | 正式执行成功依据 |
|---|---|---|---|
| acp | ACP v1 stdio | initialize + session/new | session/prompt 返回 end_turn |
| mcp | stdio、Streamable HTTP、旧 HTTP/SSE | 协议协商、tools/list、Schema 和工具映射 | tools/call 直接完成、非 isError、输出 Schema 合法 |
| a2a | A2A v1 JSON-RPC、REST、gRPC；v0.3 可显式启用兼容 | AgentCard 实际发现和入口绑定 | 同一 task 达到 COMPLETED 并交付声明文件 |
| codex | Codex App Server stdio、WebSocket | initialize、initialized、model/list | 同一 thread/turn 的 turn/completed.status=completed |
| claude-sdk | 已安装的 Claude Agent SDK，Node 或 Python | SDK 初始化与能力读取 | ResultMessage/result 的 success 且非 is_error |
| opencode | 已运行的 OpenCode HTTP Server | health、providers 元数据 | 助手消息成功完成并读取服务器的声明文件 |
| cli | Codex、Claude 和明确映射的通用 JSON/NDJSON CLI | 已有程序的 help/version；只证明启动 | 退出码为零且有结构化成功终态 |
| text | 兼容已有单次输入 CLI | 无协议握手 | 退出码；仍须当前 Agent 审查文件 |

这是可调用入口集合，不是品牌能力承诺。任意 MCP 工具服务器不自动等于能承接编码任务的 Harness。A2A AgentCard 发现不证明任务权限或模型额度；Codex 模型目录也不证明账户可使用每个模型。CLI 的连接状态标注为启动检查，不冒充协议握手。

## 定义规则

共同字段为 id/label/protocol、capabilities。邀请回传时 id/label 由插件生成或填充。所有本地启动使用已存在的绝对 command 和参数数组 args；不使用 shell 拼接。配置目录 launch_env 保留最多八个既有 *_HOME/*_DIR 目录引用。实际参数由接入 Agent 查当前版本的帮助，不能照示例猜测。

网络定义采用 `server`：

```json
{"protocol":"opencode","server":{"url":"https://已授权服务器地址","directory":"服务器上的授权工作目录","auth":{"basicEnv":"已存在的认证环境变量名称"}},"capabilities":{"modelSelection":true}}
```

认证只保存环境变量名称，工作进程直接使用宿主已有环境；Agent 不读取、复制或回传变量值。支持 bearerEnv、basicEnv（值为 username:password）、headerEnv（认证头到变量名的映射），三者选一。OAuth 登录和凭据刷新须由对应 Harness 或服务完成，插件不启动登录或自动安装软件。邀请只覆盖用户已授权的具体服务。

远端地址必须 HTTPS/WSS；HTTP/WS 仅接受 localhost、127.0.0.1、::1。禁止 URL 凭据、凭据查询参数、重定向和关闭 TLS 验证。AgentCard 和 SSE 不能把连接导向未登记的来源。WebSocket 当前不添加自定义认证头；需要这种认证的 Codex 服务应使用本机 stdio 或既有的兼容接入方式。

### MCP

```json
{"protocol":"mcp","server":{"url":"https://已授权服务器/mcp","auth":{"bearerEnv":"现有变量名"}},"mcp":{"transport":"streamable-http","era":"auto","tool":"实际任务工具","arguments":{"实际提示词字段":"{prompt}"},"deliveryField":"实际文件数组字段"}}
```

transport 可为 stdio、streamable-http、sse。stdio 继续使用 command/args；其他传输由宿主沙箱中的网络工作进程接入 server.url。arguments 必须包含 {prompt}，使用实际工具 inputSchema 提供必填字段；{workdir}/{model}/{reasoning} 仅映射实际支持的字段。占位符只替换一次，不二次展开用户提示词。

era 只接受 legacy、auto、modern 三个模式，默认 legacy。2025-11-25、2025-06-18、2025-03-26、2024-11-05 是 legacy initialize 可以协商的 protocolVersion，不是 era 的合法值。例如握手返回 protocolVersion=2025-06-18 时，应使用 era=legacy，不能把日期写进 era。

auto 先以 2026-07-28 元数据调用 server/discover；普通错误（包括 Method not found）或有界超时后，关闭原受管进程并重新建立连接，再发送 legacy initialize，避免复用探测过的连接。现代版本错误仍不能降级。modern 只接受现代生命周期：不发送 initialize/initialized，每次请求携带版本、客户端身份及能力元数据。现代服务端反向请求和需要额外输入的 InputRequiredResult 会明确失败，不自动批准权限。检查回执中的 negotiationAttempts 保留两条路径的结果或错误，modern 强制模式失败时不会自动改报 legacy。

0.2.4 起，连接检查共用 15 秒绝对期限，版本预检、启动、发现和重连都计入。发现请求等待最多 4 秒且不超过剩余预算的三分之一，给慢启动入口留出响应时间，也为新连接的旧握手保留预算。请求超时仍可在剩余预算内降级；调用方取消、总期限耗尽、损坏传输或明确的现代版本拒绝不能重启检查。清理可能需要等受管进程停止，耗时会单独记录，超期不报告 ready。

connection.diagnostics 记录本次 requestedEra、discoveryTimeoutMs、totalBudgetMs、launchMs、reconnectCleanupMs、cleanupMs、elapsedMs、signalAborted、abortSource 和 fallbackDecision；连接检查还记录 versionProbeMs/connectionBudgetMs。fallbackDecision.attempted 表示已经尝试重连，blockedBy 解释为何没有进入 initialize；是否实际发送旧握手以 negotiationAttempts 为准。旧回执未记录实际模式时不能仅凭 modern 条目推断是 auto。设置中的“连接检查记录”显示这些结果，工具回执保留完整诊断。

0.2.5 起，失败后清理不会覆盖原来的 protocolStage、错误及 negotiationAttempts。协议异常的 diagnostics.failure 保存原失败的阶段/分类/代码，cleanupFailure 单独记录清理错误，cleanupDeadlineExceeded 记录清理结束时是否已超期。只有前面操作成功、首次在最终清理失败时才报告 stage=cleanup；initialize 期间超时，无论请求定时器还是总预算定时器先被执行，都保留 stage=initialize。取消及总期限仍有效，超期不会报 ready。

MCP 每次任务都重新发现工具并比较映射指纹，漂移须重新登记检查。支持 JSON Schema 2020-12 和显式 draft-07；不加载外部引用。不支持必须异步 tasks 扩展的工具。

同一邀请最多两次检查。retryAllowed=false 后，不能继续使用该邀请回传；登记会话可使用 coordinator_control action=connect、id=已有端点、definition=修正后的完整调用定义，或重新生成邀请。修改 mcp.era 时保留 mcp.transport/tool/arguments 等已有字段；definition.mcp 是完整对象，不是逐字段合并。

网络 MCP 必须在 structuredContent 的 deliveryField 对应字段返回文件数组，例如：

```json
{"files":[{"path":"任务声明的相对路径","text":"本轮实际文件内容"},{"path":"另一个声明路径","base64":"完整文件字节的base64"}]}
```

文件 path 必须逐一匹配任务 outputs；每项只接受 text 或 base64 一种内容。不能用服务器自报的本地绝对路径代替交付，不自动下载外部资源链接。

### A2A

```json
{"protocol":"a2a","server":{"url":"https://已授权AgentCard服务器","cardPath":"/.well-known/agent-card.json","transport":"JSONRPC","legacyCompat":false}}
```

transport 可省略（从已发现的同来源接口中选择），或指定 JSONRPC、HTTP+JSON、GRPC。当 gRPC 使用另一端口时，必须在同一邀请的 server.interfaceUrl 明确登记该完整入口地址；SDK 使用 URL 的 authority 建立 gRPC 通道，TLS 选择由该 URL 决定。未显式授权的跨来源接口不采用。

插件使用官方 @a2a-js/sdk 1.3.0。v0.3 兼容须显式 legacyCompat=true，并提供实际旧版卡路径。正式派发携带独立消息 ID，只跟踪该返回的 task ID；工作中有界查询状态，失败、输入等待和认证等待不会当成功。取消时尝试 CancelTask，服务端是否真正停止仍须证据。

产物 name 或首个 part.filename 应匹配 outputs 的相对路径。支持内联 text 和 raw 文件字节。只返回 Message、远端 URL 或缺少声明文件时，任务不能算完成。模型/思考选择不通过非标准 metadata 猜测。

### Codex / Claude SDK / OpenCode

Codex stdio 使用实际 Codex 可执行程序和 app-server 启动参数。WebSocket 使用 protocol=codex、server.url=已运行的 WS/WSS 地址。任务可使用实际模型和 effort；不覆盖服务器配置中的审批、沙箱和权限配置，也不提供额外动态工具。

0.2.6 起，普通 commandExecution/fileChange 审批转交原任务会话。Agent 先从 coordinator_status 的 tasks[].approvals 核对完整命令、工作目录或实际补丁，再调用 coordinator_control action=approval，携带任务 id、approval_id、approval_version 和 decision=accept，经 DSH 原生 approval.request 获得 allowed-once 后，才向 Codex 回复单次 accept；decision=cancel 拒绝本次操作。DSH 设置页也可查看具体操作后点击“批准这一次”或拒绝。批准后继续同一线程和回合，不重新派发任务。acceptForSession 和规则修订没有采用。

批准绑定原任务会话、runId/revision、线程/回合/item 和不可变操作版本。取消、暂停、失效、重启、超期或回合结束都会撤回；迟到或重复批准不执行。命令 cwd、补丁原路径和移动目标须在本任务工作区，答复前重新核对，链接越界拒绝；命令具体效果仍由原会话审查，cwd 不能证明命令安全。不批准缺少完整操作、extra permissions、networkApprovalContext、grantRoot、elicitation 或其他未接入交互，不读取凭据，不修改全局配置。DSH 策略拒绝、审批渠道不可用时明确失败，不自动放权。

失败结果保留已有 Agent 输出、受界限约束的 stderr、commandOutput、phase/failedPhase、lastNotification、退出码和审批记录；常见凭据形态会隐藏。仅完成握手不证明执行或绘图可用。正式产物仍须真实读取、逐项审查；审批通过不自动通过任务验收。

0.2.7 起，Codex stdio/WebSocket 每条消息统一上限16MiB，支持 imageGeneration.result 的大图片内容；MCP的1MiB限制保持原规则。首先发生的解码、超限、传输、超时或进程退出原因保留在 native.transport.failure，统计在 native.transport.stats。native.generatedImages 只保存本回合的图片路径、状态、结果长度，不保存图片块；生成完成与turn完成、文件交付、媒体审查分别判断。普通复制命令只校验cwd，源文件在已授权的CODEX_HOME缓存中不会仅因源路径而触发该校验；命令本身仍须原会话逐次审批。

每次任务运行在协调器dataDir/run-logs下写独立JSONL，路径和状态见 task.diagnosticLog/result.diagnosticLog。日志白名单只含阶段、事件方法、请求身份、大小、审批结果/拒绝原因、图片产物路径和退出信息；不记录请求参数全体、提示词、原图base64或聊天历史，单日志最多1MiB。UI“查看运行日志”和coordinator_control action=log、id=任务编号读取原会话当前任务日志；外会话及任意路径读取拒绝。日志满或写入失败会在摘要中标明，不伪装成完整记录。

0.2.9在DSH派发Codex任务前读取原会话approvalContext；never、缺审批服务或策略未知时记录task.approvalPreflight并blocked，不先花费模型任务探测。ask仅证明可请求，实际答复者仍可能unavailable。后续审批再次核对，禁用提示与操作被拒分别报告，不改用户策略。协议ready不证明原会话能批准操作。

coordinator_control action=collect、id、image_item_id、relative、note显式回收本轮已记录的本机Codex stdio缓存PNG，不接受任意源路径，不扫描缓存。只支持原会话已有danger-full-access及声明输出；其它模式由宿主文件能力按现有权限处理。检查缓存/工作区边界、普通PNG文件、事件哈希（旧记录可能没有）及目标哈希，不覆盖不同内容、不复制远端savedPath。result.recoveries记录交付，原result.ok/error/native不变，全部声明产物回收后等待原Agent读取和媒体审查；执行失败不能改报执行成功。详见[0.2.9修复记录](修复记录-0.2.9.md)。

Claude SDK 使用 protocol=claude-sdk、command=实际 Node/Python 解释器、sdk.language=node 或 python。Node 还须 sdk.module=已安装官方 SDK 导出 query 的文件绝对路径；Python 使用解释器已经安装的 claude_agent_sdk。sdk.cliPath 可指向已有 Claude CLI 文件。Node 检查保持提示词流为空，Python 检查只 connect/get_server_info；二者都不提交探测模型任务。正式调用只使用已配置的认证和模型，不改变 permissionMode，不自动批准 canUseTool 请求。SDK 自身的子进程处于宿主启动的工作进程沙箱内。

OpenCode 只连接已运行的服务器，不自动启动或改动服务器权限。directory 明确服务器工作区；不把本机 cwd 当成远端目录。模型选择使用真实 providerID/modelID。正式调用创建会话，提交 message；无成功终态时失败。任务完成后仅读取事先声明的 file/content 路径并交付到当前工作区，不删除服务器会话。服务端的执行权限由服务端控制，客户端沙箱不能替代服务端沙箱。

### 结构化 CLI

protocol=cli，cli.preset 为 codex、claude 或 generic，cli.format 为 json/ndjson。command/args/prompt_mode 以当前程序真实帮助为准。probe_args 必须是无任务 help/version 参数，不能携带提示词。Codex 接受 turn.completed，turn.failed/error 判失败；Claude 接受 result/subtype=success 且非 is_error。generic 须设置 successField（点分字段路径）和 successValue，只有明确终态与零退出码同时成立才成功。输出解析失败、超过 2MiB 或缺终态均失败。

## 执行与审查

所有本地进程和网络工作进程经 DSH subprocess/sandbox 启动。网络请求在工作进程内发出，不绕过会话沙箱到插件主进程直连。网络工作进程保存阶段错误并隐藏已引用凭据，第三方 stderr 原文不持久化。

远端文件只能写到已声明输出、拒绝目录链接越界和重复路径。每文件上限 8MiB、本轮合计 16MiB；MCP 单消息另有 1MiB 上限。缺少本轮文件交付时，既有本地文件不能代替新交付。全部产物仍进入当前 Agent 的真实读取、哈希和逐项审查流程，远端“完成”不自动放行下游。

新会话会看到允许共享的执行端；排队后撤回共享会在实际派发前阻断。插件重启保持任务暂停，不能自动重试有副作用的远端操作。取消只说明本机调用停止或取消请求已尝试，不能凭此断言远端停工或撤销计费。

## 验证来源和边界

协议依据：[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)、[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/schema)、[A2A 官方 SDK](https://github.com/a2aproject/a2a-js)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[OpenCode Server](https://opencode.ai/docs/server/)。

核心测试使用本地协议服务器、官方 A2A SDK 三种传输、假 SDK 和测试 CLI，不调用付费模型。Python SDK 夹具需 COORDINATOR_TEST_PYTHON 指向 Python；缺少时明确跳过。真实产品当前版本、登录态、模型权限、生产服务器和媒体能力仍须用户邀请后的实际检查。ACP v2、自动 OAuth、任意厂商私有接口和远端资源 URL 下载没有宣称支持。

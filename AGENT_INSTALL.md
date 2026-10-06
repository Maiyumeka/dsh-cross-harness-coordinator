# Agent 自行安装协调插件

用户把安装请求发给你后，由你完成检查、备份、安装、启用和验证。你与用户使用同一个 DSH 原生插件管理服务，权限由宿主决定。不要让用户转抄参数或替你执行技术步骤。

首次安装使用原生热加载：DSH 保持打开，安装后直接出现设置栏目。不能把退出 DSH 当作安装的必做步骤。

## 本机发布资料

`.local-install.json` 是被 Git 忽略的本机路径配置，不随仓库或 worktree 自动复制。新 worktree 构建发布资料前须有自己的配置，或设置 `COORDINATOR_DSH_CLI`、`COORDINATOR_DSH_ASAR`、`DSH_HOME`、`COORDINATOR_DSH_PROFILE` 等明确路径。可以核对后从本机主仓库复制已有配置；不要把该文件放进公开仓库。cli/asar 缺失时检查器会拒绝安装，先补齐并重新生成发布清单，不能绕过运行时检查。

- 在工程根目录读取 `dist/agent-install.json` 获取当前安装包、SHA-256、固定验证的 DSH 版本和默认路径。以实际当前 DSH profile 为目标；工具操作的是当前 profile，不能用 desktop 的备份证明另一个 profile 的安装。
- 检查器：`node scripts/agent-install.mjs check`。
- 备份：同一检查器执行 `prepare`，保存返回的 backup 路径。默认读取 DSH_HOME，未设置时使用本机 desktop；实际 profile 不同时由你加 `--home` 与 `--profile`。用户不用填写。
- 备份保存 profile 顶层配置、清单、锁文件、宿主补丁和原会话文件清单；不复制会话正文，不是整个 DSH 数据目录的完整备份。安装服务不会迁移、删除会话。

## 安装

1. 首选当前 DSH 会话原生 `plugin_manager` 工具。先 list_bundles / list_plugins，获取当前 profile、现有状态和精确标识。宿主要求的正常单次授权照常处理，不切换用户安全设置。
2. 确认没有会被修改影响的工作。首次安装不会重启 DSH；其他不受影响的会话可以保持打开。已有本插件升级时先检查协调任务空闲，不能关闭正在执行本安装的会话，也不能强制结束任何工作。
3. 检查和备份通过后调用 `plugin_manager`：`action: install_bundle`，`target: 发布资料中的 archive`，`enabled: true`。这是 DSH 插件页使用的同一个安装服务，支持 live profile 热加载。
4. 若本 Harness 没有该工具，但能操作 DSH 界面，使用 DSH 原生插件页的安装入口，粘贴同一个安装包路径并启用；这也是同一服务。不要读取浏览器私有数据、复制其他会话令牌或绕过认证。没有任何可用安装入口时，如实说明缺失能力，不能假报安装。
5. 不自行批准新的包安装脚本或版本豁免。本插件没有安装生命周期脚本，适配 DSH 0.2.0-rc.2；遇到版本不兼容、权限拒绝、包构建授权、路径歧义或错误时报告宿主返回的具体原因。

## Agent 自行更新（0.1.2 起）

用户要求更新时，由你完成以下步骤，不要求用户退出 DSH。检查器 check 会返回 install/update、已安装版本及待处理任务；相同版本无需重复安装。

1. 先使用当前会话 coordinator_status 和实际插件状态核对工作空闲；0.1.11 起还须核对 settings.activeConnections 为0，prepare 会拒绝正在检查协议连接的执行端及尚在执行、停止中、排队或待审查的工作。不要擅自取消工作。需要暂停时用合法暂停流程并等待受管任务真正停止。保持其余会话和宿主运行。
2. 读取目标发布资料，执行 check / prepare，备份配置、清单、锁文件和协调器状态。使用原生 plugin_manager install_bundle 安装目标包。
3. 0.1.2 起使用独立版本包名（例如 dsh-cross-harness-coordinator-v0-1-2），发布资料中的 name 是目标 bundle；canonicalName 用于识别此前的协调器。先 install_bundle，target 为 archive，enabled:false，确认 application:applied；保留旧依赖作为恢复入口。随后对 prepare 返回的 previousBundles 逐一 set_bundle enabled:false，再对目标 name 执行 set_bundle enabled:true。每一步必须检查 application。只能切换本协调器，不修改其他插件，不卸载旧包。
4. 独立包名让宿主和客户端都加载新版，避开 DSH 已缓存的旧代码。刷新 DSH 界面一次，让旧客户端重新绑定当前会话；这是刷新界面，不是退出应用。具备界面能力的 Agent 自己完成刷新并恢复原会话。如果目标安装或激活失败，不继续重复尝试；目标已激活则先停用目标，再恢复此前启用的 bundle 一次，记录结果并报告。restart-required 不能当作成功。
5. 执行 verify，检查原依赖、无关 bundle、会话文件和安装哈希；随后检查 coordinator_status 返回的 version、界面“当前运行版本”以及实际操作。只有磁盘与当前运行版本都等于目标，才能报告更新成功。目标未采用独立版本包名或无法重新加载时不要套用此流程，明确无法完成热更新。
6. 未完成工作保持暂停，邀请需要重新生成。旧版本登记的 ACP 端没有连接证据时显示待验证，不能当作连接可用；升级本身不自动检查真实端。实际产物/输入和日志核对后才恢复，不能因为软件更新重新派发已经完成的任务。不要替用户接入真实 Harness。

## 检查结果

1. 原生返回 `application: applied` 才表示本次应用成功。restart-required 表示尚未生效；failed/cancelled/overridden 均不能当成功。不要为更新关闭宿主。
2. 执行检查器 `verify --backup 上一步返回的路径`，实际 profile 与 prepare 相同。检查所有包内文件哈希、bundle 启用、原依赖与会话文件未减少。该结果只证明磁盘安装，不能替代下一步。
3. 原生 list_plugins 中本插件宿主与客户端条目已启用且无错误；当前会话可发现 7 个 `coordinator_*` 工具；调用 `coordinator_status` 返回有效状态；打开 DSH 设置能看到“协调器”。具备界面能力时查看实际栏目。没有界面能力时明确写“界面待验证”。
4. 已安装且已运行、已安装待重启、未成功，以及尚无法验证的项目分别如实报告；附版本、备份路径和简短证据。不要仅凭安装命令退出码报告成功。
5. 本次仅安装插件，不创建接入邀请、不登记真实 Harness、不修改旧协调器数据、不恢复定时任务。用户亲自发送第一条接入邀请。

## 可复制给 Agent 的安装请求

请读取 AGENT_INSTALL.md，帮我在不退出 DSH 的情况下安装或更新跨 Harness 协调插件，完成备份和生效检查。技术步骤由你完成，不让我填写参数。不要中断运行中的工作；暂时不要替我接入真实 Harness。完成后告诉我运行版本，以及如何从设置中的“协调器”进入。

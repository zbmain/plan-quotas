# 开发与维护说明

用户部署和使用说明见 [README](../README.md)，外部额度协议见 [quota-api.md](quota-api.md)，渠道认证依据见 [providers.md](providers.md)。

## 本地开发

使用 Node.js 26 LTS，当前固定版本为 `.node-version` 中的 26.13.0。依赖由根目录 `package-lock.json` 锁定，工作区统一安装，不在各子目录单独安装。

```sh
npm ci
npm run build
npm start -- --host 127.0.0.1 --port 8000
```

开发时运行 `npm run dev` 启动后端监听；另一个终端运行 `npm run dev:frontend`。也可以使用 `just install`、`just dev`、`just frontend`。从项目根目录启动，以正确解析 `.env`、`DATA_DIR` 和 `STATIC_DIR`。

```sh
npm run typecheck
npm run lint
npm test
npm run test:frontend
npm run build
# 一次完成以上检查
npm run check
```

测试中的官方 MCP 客户端需要监听本机临时端口。后端、前端测试和构建均独立使用 Node，不需要其他语言解释器。业务函数应有准确的函数级注释。不要提交 `.env`、任何位置的 `.venv`／`venv`、运行数据、备份、密钥或真实认证资料。

## 工程职责

- `shared`：Zod 4 校验模型、公开 TypeScript 类型、12 个渠道目录、MCP 工具说明及输入 Schema。前端只导入公开类型。
- `server`：Fastify 5 服务、固定地址渠道适配器、凭据加密、管理员认证、采集、历史与搜索路由。加密和文件路径逻辑不进入前端。
- `frontend`：保持现有页面和交互。`ProviderIcon` 统一渲染卡片、账号列表和渠道选择器图标；资源来源与许可保留在本地静态资源目录。

生产构建由同一个 Node 进程提供 HTTP、静态资源、MCP 和后台采集，无数据库、子进程采集器或运行时桥接。Docker 以 UID/GID 10001 运行，内部端口 8000；Compose 使用 `DATA_DIR` 指定宿主机数据目录，未设置时使用 `plan_quotas_data` 命名卷。基础镜像为 Node 26 Alpine，健康检查使用原生 `fetch`。

## 持久化与迁移约束

继续读取原配置 `config.json`、`secrets.enc`、`master.key`、账号快照和按日期分片的历史 JSONL。配置版本保持 1，保留 ID、别名、顺序、启停、搜索开关、UTC 时间字符串及旧采集周期。新配置默认每分钟采集，管理界面接受 0.5、1、2、5 分钟；浏览器每 30 秒读取缓存。

渠道凭据沿用原 AES-256-GCM 格式：32 字节二进制主密钥、12 字节 nonce、AAD `plan-quotas-secrets-v1`，认证标签保存在密文最后 16 字节。旧 PBKDF2 接口密码不再鉴权，迁移时仅保留原访问保护意图；新 Token 使用独立加密文件。已有加密数据缺少主密钥时拒绝启动。

存储使用临时文件、fsync 和原子替换，普通配置与渠道凭据保留 `.bak`，损坏时验证备份再恢复；访问 Token 文件不自动回退，避免复活已撤销的密钥。删除账号时同步清理配置和渠道凭据备份，避免恢复已删除的凭据。目录权限为 0700、文件为 0600；拒绝符号链接、特殊文件和不安全的账号路径。JSONL 写入前修复不完整末行，读取忽略坏行，按 30 天清理。

Node 实例通过 `proper-lockfile` 锁定数据目录下的 `.node-lock`：心跳 5 秒、失效阈值 30 秒，竞争立即失败。锁失效后拒绝写入并停止服务。旧运行时与 Node 的锁不互认，因此升级时必须先停止旧容器；不能让两种服务同时写原数据卷。备份必须包含完整数据目录和主密钥，回滚同时恢复备份与旧镜像。

时间计算使用 Temporal，原有微秒时间字符串不经 `Date` 重新序列化。历史分桶先计算纳秒差，避免浮点时间戳使观测跨桶。OpenDesign Credits 使用 `decimal.js` 字符串运算，精度 64 位，仅将计算后的有限百分比写入数值字段。

## 渠道与调度

`server/src/adapters` 中的每个适配器实现 `fetch(credentials, authType, client)`，返回统一 `UsageResult` 和可选的续期凭据。渠道固定为 MiniMax、GLM、Kimi、DeepSeek、火山引擎、阿里云百炼、Codex、Claude、Cursor、OpenCode、OpenDesign、Google Antigravity。

HTTP 使用原生 `fetch`，验证 TLS，不跟随重定向。每次请求及响应流读取受 15 秒超时约束。自动采集的网络错误（含超时、断连及响应流中断）首次失败后最多重试 3 次，共最多 4 次请求，间隔为 250、500、1000 毫秒；重试期间保留现有快照，全部失败后才写入采集异常。手动刷新和连接测试的网络错误仍最多重试一次，服务端临时故障也最多重试一次；认证失败、限流和格式错误不盲目重试。重试策略按异步采集上下文隔离，不影响搜索的单次调用规则。只有渠道真实提供或可明确推导的数值进入结果，缺失保持 `null`，不能从百分比虚构 Token。

采集与连接测试共用四个并发名额，同一账号使用互斥锁；手动刷新冷却 60 秒。排队后重新检查账号启停和凭据版本，防止旧请求覆盖新配置。认证失效暂停自动采集，错误保留上次成功值并标记过期。历史写入失败不丢弃已保存的最新快照。

GLM 保留原始持久化指标，但卡片、HTTP/MCP 和趋势仅展示 MCP 总池，隐藏 `glm-mcp-*` 明细；历史重置只基于可见指标。MiniMax 搜索是套餐共享额度，独立次数未知。DeepSeek 和 OpenDesign 钱包为独立金额，零余额不等于模型套餐耗尽。

## HTTP 与 MCP

`GET /info` 返回当前 V2 `version/updatedAt/refreshIntervalSeconds/accountCount/healthy/low/errors/accounts`，账号仅保留 `channel`。页面内部 `/api/public/*` 和存储结构保持原样，外部协议的统一投影位于 `server/src/quota-protocol.ts`。

账号数、正常数、额度紧张数和异常数直接放在最外层（`accountCount/healthy/low/errors`），不再嵌套 `summary`；移除 `totals/skipped` 及其额度分组合计代码。`accountCount` 与 `accounts` 清单区分，HTTP 和 MCP 共用相同结果，账号内的额度字段及 `total` 不变。

MCP 使用官方 TypeScript SDK v2，Streamable HTTP 无状态传输。五个工具名称、参数、中文标题、说明和默认值保存在 `shared/src/mcp-tools.json`；低层 `Server` 注册协议处理器，`server/src/mcp.ts` 提供严格白名单和安全中文校验。四个只读工具只接受 `channel`（默认 `all`），不再解析账号、周期、状态或工具筛选；`protocolHistories` 按渠道和配置顺序批量返回固定 24 小时的历史。搜索只接受 `query/channel`（默认 `auto`），移除账号和结果条数输入。额外参数拒绝执行，查询不触发采集，搜索参数错误不能消耗额度。

`/info` 与 `/mcp` 共用最多 5 个访问 Token，仅接受 `x-api-key` 请求头或 `?x-api-key=`。请求头字段名不区分大小写，查询参数固定小写；头与查询参数必须一致，同名字段重复、格式错误或冲突时拒绝。旧 `apikey`、`password`、`X-API-Password` 和 Bearer 不再鉴权。解析发生于路由和日志前，查询字符串清空，规范化及原始请求头中的新旧敏感字段均移除；日志仅记录方法、路径和状态。保留管理员会话、CSRF、Host/Origin 和失败限流，API Token 不授予管理权限。

Token 为 `sk-` 加 32 个密码学随机字节的 Base64url 编码，使用固定长度 SHA-256 摘要恒定时间比较。访问方式及完整 Token 存在独立 `api-access.enc` 中，由现有 `master.key` 使用 AES-256-GCM 加密，AAD 为 `plan-quotas-api-access-v1`。原子写入、不自动恢复旧 Token 备份；配置和配置备份记录迁移标记。备份与恢复须包含完整数据目录及原主密钥。迁移后访问文件缺失、损坏或主密钥缺失均拒绝启动；原密码保护实例保留密钥模式，等待管理员创建新 Token。

管理员接口：`GET/PATCH /api/admin/access-settings` 返回/保存 `require_apikey`，GET 同时返回 `limit` 与仅含 `id/created_at` 的 Token 列表；`POST /api/admin/access-tokens` 生成并返回元数据，`POST /api/admin/access-tokens/:id/reveal` 返回 `{apikey}`，`DELETE /api/admin/access-tokens/:id` 撤销。所有非 GET 操作要求 CSRF，响应禁止缓存。旧 `/api/admin/info-settings` 已移除。

GLM 搜索通过官方 SDK 调用固定远程 `web_search_prime`／`webSearchPrime`，MiniMax 使用固定 HTTPS 接口。搜索默认关闭；指定渠道时只在该渠道内按后台账号顺序尝试，`auto` 使用全部账号的后台顺序。异常、不可用时使用下一优先级账号，合法空结果也停止。并发上限四个、每账号一个，单次 15 秒、整体 60 秒；没有同账号自动重试，最多返回 10 条。只使用新鲜且适用的共享额度判断耗尽，不增加本地次数来冒充供应商账单。

## 兼容基线与测试

迁移前的 335 项后端行为已整理并迁移，测试不再导入或启动旧服务。`server/test/fixtures` 仅包含脱敏合成资料：

- 167 组渠道请求／响应契约，比较固定 URL、请求方法、字段解析、错误和 OAuth 续期；
- 62 组 OpenDesign 解析边界，包括超大 Credits、未知与超额、工作区校验、空重置及团队权限；
- 18 组 V2 额度和 8 组页面数据投影；
- 一组旧加密格式和密码摘要的确定性兼容样本。

此外覆盖文件损坏恢复、备份、并发、限流、排队后配置变化、共享额度去重、日志脱敏、官方 MCP 客户端及 2025-06-18 协议协商。搜索用模拟上游，既不需要真实密钥，也不消耗真实搜索额度。原有 50 项前端测试保留。

样本测试通过不等于每个供应商真实账号均已验证。实际渠道状态仍见 [providers.md](providers.md)，不得因为运行时迁移将未实测渠道改为已验证。

## 本轮迁移验收（2026-11-07）

- Node.js 26.13.0 下完整执行 `npm run check`：441 项后端测试、50 项前端测试通过，类型检查、ESLint、Prettier 和生产构建通过。构建保留已有的前端大分块提示。
- 干净锁文件安装和 Docker 构建覆盖 Linux arm64、amd64；两个镜像均实际启动并通过健康检查。amd64 在当前 ARM 机器的 Docker 模拟环境中验证，未单独使用原生 x86 主机。
- 正式容器 UID/GID 为 10001，根文件系统只读；镜像中没有 Python 解释器，`/app` 内没有 `.py`。项目源码、测试、uv 配置、虚拟环境和本项目 Python 缓存均已移除；系统解释器未修改。
- 旧服务停止后备份完整数据卷及主密钥；副本上的 V2 `/info` 投影与切换前响应深度比较完全一致。切换后六个账号、配置字节、主密钥和全部凭据摘要一致，原有 14 个历史 JSONL 文件的原字节内容完整保留。容器重启后再次核验通过，六个真实账号均采集正常。
- 官方 TypeScript 客户端连接正式 `/mcp`，验证五工具发现、账号、套餐、GLM MCP 总池及 OpenDesign 历史查询。搜索只使用模拟结果和空白参数验证，没有额外消耗真实搜索额度。重复实例挂载同卷立即退出，退出码为 1。
- Ego 验证 1440px 桌面、390px 手机、深浅主题、已用／剩余切换、图标及管理员登录；两种宽度均无横向溢出，页面保留六个账号，后台凭据仅显示掩码。

数据备份留在本机被忽略的 `backups/typescript-2026-11-07T03-41-25-058Z/data.tar.gz`，回滚镜像为本地 `plan-quotas:before-typescript-20261107`。备份和回滚镜像不属于源码或分发镜像，不应提交到远程。

## MCP 参数简化验收（2026-11-07）

四个只读工具的输入均只保留 `channel`；历史固定返回所选渠道已启用账号的 24 小时记录，空渠道返回空数组。搜索输入仅 `query/channel`；指定渠道只在该渠道内按后台顺序故障切换，`auto` 使用全局账号顺序。多余参数（包括旧字段的合法默认值）直接拒绝，不能消耗搜索额度。

完整检查通过：436 项后端测试、50 项前端测试、类型检查、ESLint、Prettier 和生产构建。已移除针对旧账号选择及周期别名的过时用例，保留指标和持久化基线，并增加七类搜索故障、跨渠道与渠道内排序、管理排序变更、只读批量历史及官方 MCP 客户端输入校验。搜索路由测试均使用模拟上游，不调用真实套餐搜索。

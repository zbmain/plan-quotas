# 开发与维护说明

本文面向参与项目开发和渠道维护的贡献者。用户部署与使用说明请见项目根目录的 README。

## 本地运行

要求 Python 3.11、uv、Node.js 22 或兼容版本，以及 Just。

```sh
uv sync --all-groups
cd frontend && npm ci && cd ..
just build-frontend
just dev
```

前端开发服务器可在另一个终端运行 `just frontend`。环境变量可复制 `.env.example` 并按需设置。生产构建由 Dockerfile 执行。

## 质量检查

```sh
just lint
just test
just build-frontend
just build
```

新增 Python 函数和前端关键函数时应添加准确、简明的函数级注释。测试不得依赖真实供应商密钥；使用脱敏响应样本覆盖正常、缺字段、异常值、限流和认证错误场景。不得提交 `.env`、`.venv`、`venv`、运行数据、密钥或真实凭据。

## 运行约定

应用由一个 Uvicorn worker 提供服务，后台采集、Web 查询和 MCP 工具共享统一的缓存与历史服务。存储为本地文件，不依赖数据库。部署保持单实例；多个容器不能同时挂载并写入同一个数据卷。

新配置默认每 1 分钟采集一次；管理接口仅接受 `interval_minutes` 为 `0.5`、`1`、`2` 或 `5`。存储模型仍可读取旧版自定义周期，管理员下次保存时需选择四个新周期之一。服务端按周期请求渠道；首页每 30 秒读取缓存，这两种计时相互独立。

本地运行可通过 `DATA_DIR` 和 `STATIC_DIR` 指定数据及前端目录；`.env.example` 中的相对路径适用于从项目根目录启动。Compose 固定使用容器内 `/app/data` 和 `/app/frontend/dist`，并将数据挂载到 `plan_quotas_data` 命名卷。健康检查使用 `/healthz`，该端点不得返回凭据或内部文件路径。

数据目录与前端静态目录必须完全分离，不能相同或互相包含；应用会解析符号链接并拒绝不安全的目录配置，防止主密钥和加密凭据被静态服务公开。

## MCP 集成

MCP 服务位于 `/mcp`，使用 Streamable HTTP 和独立 Bearer Token。远程访问应通过 HTTPS 反向代理。令牌只在管理后台创建时明文展示，服务端只保留验证所需的摘要；查询工具只能读取缓存和历史。

## OpenCode 适配（2026-10-27）

- 使用独立 `opencode` 适配器，注册到相同的采集、历史、`/info` 和 MCP 查询服务。API Key 仅请求固定的 `/inference/go/v1/usage`；Cookie 仅请求固定 Console JSON 接口，并通过必填的 `x-org-id` 指定工作空间。禁止自动选取第一个工作空间，禁止任意 URL 和跨域重定向。
- Go `usage.rolling/weekly/monthly.percent` 是 0～100 的百分比，保留超额；缺测保持未知，不把低于 1 的百分比扩大 100 倍。Console `access.meters.fiveHour/week/month` 以 `usedMicroCents / limitMicroCents` 计算比例，月窗口缺少重置时间时使用 `access.endsAt`；其他窗口缺失重置时间时不推断。
- 余额仅接受 `billingMode=prepaid`、`mode=pay-as-you-go` 的 `balanceMicroCents`，除以 `100000000` 得到 USD；`availableMicroCents` 不可替代余额。可选余额失败保留有效 Go 额度，没有订阅也没有支持的余额时返回安全错误。403 订阅权限错误使用 `subscription_unavailable`，不会与 401 凭据失效混淆。
- 依据：[官方 Go 用量响应实现](https://github.com/anomalyco/opencode/blob/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/console/app/src/routes/zen/go/v1/usage.ts)、[官方迁移代理](https://github.com/anomalyco/opencode/blob/5916014733c9f8cf9aaba5810c45d3092f74dd38/packages/console/app/src/lib/inference-proxy.ts)、[CodexBar Console 适配测试](https://github.com/steipete/CodexBar/blob/6070b29a1a5d51193a634dc1b0a14a67c39d0ccc/Tests/CodexBarTests/OpenCodeGoConsoleMigrationTests.swift)。官方当前 [Go 使用说明](https://opencode.ai/docs/go/) 与 [账号 Key 获取讨论](https://github.com/anomalyco/opencode/issues/52227) 用于维护认证指引。
- 未登录探测确认新 `/inference/go/v1/usage` 与兼容 `/zen/go/v1/usage` 均返回 JSON 401；此结果只证明路由存在，不代表真实账号验证通过。未自动读取本机 OpenCode 凭据或会话数据库。
- 验证：139 项后端测试、39 项前端测试、Ruff 和生产构建通过。独立临时数据目录与模拟上游完成 API Key 的连接测试、保存及采集流程，核对 Cookie 必填工作空间字段、三周期已用／剩余切换、余额独立展示、深浅主题与 320px 手机布局。验收样例未写入用户的运行数据目录；真实凭据仍待用户在后台配置并核验。

## 管理按钮交互（2026-10-27）

- 账号刷新使用独立的进行中状态：图标旋转、按钮禁用并阻止重复提交；快速响应至少保留 700ms 动效，完成或失败后恢复。服务端在 60 秒内重复刷新会返回缓存，因此成功提示使用“刷新请求已完成”，避免把缓存结果描述为新的上游采集。
- 地址和 MCP 令牌复用同一个复制按钮。优先调用 Clipboard API；普通 HTTP 来源没有该 API 或权限被拒绝时，尝试临时只读文本框的选择复制。临时值立即清空并移除，恢复按钮焦点；复制成功短暂显示对勾并提示，失败提示手动复制。提示区域支持屏幕阅读器。依据：[Clipboard API 安全上下文限制](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)。
- 44 项前端测试与生产构建通过。独立临时实例在真实局域网 HTTP 来源验证 `isSecureContext=false`、Clipboard API 不可用时，`/info` 与 MCP 地址均可写入系统剪贴板；仅比较预期地址，不记录剪贴板原文。另验证复制拒绝提示、临时文本清理、刷新实际旋转、单账号忙碌状态、重复点击不新增请求及按钮恢复。

## 渠道适配维护

每个适配器声明可用认证方式、支持的指标和查询实现。统一输出仅包含渠道实际提供或可以明确推导的数值；解析失败时返回安全错误码，不记录请求头、Cookie、令牌或完整上游响应。渠道接口变更时先更新脱敏样本和适配器测试，再检查错误状态及重试策略。

详细认证入口和真实账号验证状态维护在 [渠道与凭据说明](providers.md)。

## 验收记录

截至 2026-10-25，当前工作环境的验证情况如下：

| 项目 | 结果 |
|---|---|
| 后端自动化检查 | 84 项 pytest 通过，Ruff 检查和格式检查通过；包括目录隔离、认证、并发、历史、加密存储及时间抖动场景 |
| 前端检查 | 8 项测试通过，生产构建成功；仍有图表相关分块大于 500 KB 的构建提示 |
| 浏览器验收 | 已检查桌面、768px 平板和 390px 手机布局，以及深浅主题、管理员登录、凭据不回显、账号编辑、筛选、指标与历史区间切换 |
| 备份恢复 | 测试完整数据目录迁移，恢复后主密钥、账号配置、加密凭据、缓存和历史均可读取 |
| 普通 Dockerfile / Linux arm64 | 较早的源码版本曾构建并通过 Compose 启动验收。最后一轮存储和前端修正后，Docker Hub 元数据／授权请求连续遇到 TLS 超时，因此未用普通 Dockerfile 确认最终源码版本 |
| 最终离线镜像 / Linux arm64 | 基于本机已存在的 `plan-quotas:local` 依赖镜像，使用网络关闭的临时构建上下文，仅复制最新 `src/plan_quotas` 与 `frontend/dist`，组装为 `plan-quotas:offline-final` 并更新 `plan-quotas:local` 标签。没有包含项目数据或凭据 |
| 最终离线镜像运行 | `/healthz` 返回 HTTP 200；首页返回的 `index.html` 与当前 `frontend/dist/index.html` 一致。以 UID 10001 运行，根文件系统只读，丢弃全部 capabilities，启用 `no-new-privileges`；当前存储源码的重置判断阈值为 60 秒 |
| Linux/amd64 镜像 | 尚未验证。构建期间 Docker Hub 授权请求发生 TLS 握手超时，未能完成镜像层下载 |
| Docker Compose | 隔离配置启动成功；宿主机临时端口健康端点返回 HTTP 200。容器以 UID 10001 运行，根文件系统只读，丢弃全部 capabilities，启用 `no-new-privileges`；独立数据卷在容器重建后保留主密钥文件 |
| MCP | `tests/test_mcp.py`：2 项通过，包含官方 MCP 客户端连接本机 Uvicorn 的集成测试 |
| 渠道样本解析 | `tests/test_adapters_cn.py`、`tests/test_adapters_cn_extra.py` 和 `tests/test_adapters_global.py`：40 项通过，覆盖 10 个渠道的脱敏测试样本 |
| 真实渠道账号 | 仅 MiniMax API Key 查询验证通过；MiniMax Cookie 和其他渠道账号尚未验证 |

amd64 构建失败是当前环境下载超时，不能据此判定 amd64 镜像本身存在构建问题，也不能标记为通过。最终源码版本的普通 Dockerfile 构建同样未能完成；离线镜像验收只证明已存在依赖镜像可运行最新源码与静态文件。渠道样本解析通过不代表供应商真实接口已验证。

本次 Compose 构建使用官方 Docker Hub 镜像地址，并通过 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` 下载前端依赖。依赖锁文件保留官方源地址、固定版本和校验摘要；该构建参数可按部署网络选择。

## 额度清单更新（2026-10-26）

- 额度名称在显示层统一为中文，兼容已有缓存与历史；已识别的短周期、长周期和月度角标分别显示“5h”“week”“month”，其他实际周期分别显示。模型名称和币种保留其准确含义。
- 卡片按周期展示剩余值、已用值、总额与重置时间；MCP 和工具调用单独展示，只有已用次数的工具明细不会套用总额度。未知数值保持未知，超额数据保留原值。
- GLM 新增控制台额度接口中的 MCP 汇总和工具明细解析；旧汇总指标 ID 保持不变。该渠道仍仅完成样本验证，详见渠道说明。
- Codex 从 `limit_window_seconds` 读取实际窗口时长，缺失时保留原窗口名称，不预设 5 小时或 7 天。字段依据见 [OpenAI Codex 客户端](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)。
- 本轮验证：92 项后端测试、22 项前端测试、Ruff 与生产构建通过。浏览器检查覆盖桌面、768px 平板、390px 手机、深浅主题、MCP 明细展开及历史指标切换。MCP 界面验收使用隔离样例，未写入真实账号数据目录。
- 后续紧凑卡片调整：桌面三列、平板两列、手机单列，单账号不再跨越整行；额度改为纵向紧凑行，精确重置时间保留在倒计时的悬停提示和无障碍标签中。1920px 桌面下双周期卡片由约 582×422 缩至 384×315。22 项前端测试及生产构建通过；浏览器检查覆盖 1920px、834px、390px、320px，包含单账号筛选、深浅主题、MCP 明细、历史指标及范围切换。多币种与未知额度使用隔离样例验证，窄屏无横向溢出。
- Kimi 周期修正：统一解析 API Key 与 Cookie／JWT 的计数型响应，识别 `TIME_UNIT_MINUTE` 等时间枚举；顶层 `coding` 对应 7 天，300 分钟窗口对应 5 小时，保留指标 ID、原始额度数值和各自重置时间。Kimi 当前卡片与历史趋势显示已用比例，兼容旧缓存；其他渠道剩余值展示不变。新增真实响应格式回归用例后，20 项中国扩展适配器测试、15 项 Web 接口测试、27 项前端测试、修改文件 Ruff 检查与生产构建通过。用已配置的 Kimi API Key 实际查询得到 5 小时已用 12%、7 天已用 2%，与用户截图一致；完成桌面、390px 手机及历史指标切换验收。
- 显示方式切换：筛选栏新增原生单选器，页面默认按已用量展示，可切换按剩余量。所有配额主数值、进度条、历史数值和图例遵循同一方向；次要信息提供另一方向的数值。余额／成本不反推消费，缺少总额的工具明细不虚构剩余次数；紧张和超额警告始终按实际已用比例判断。历史数据不混合绝对数量和百分比。37 项前端测试与生产构建通过；浏览器已验证 1440px 桌面、768px 平板、390px 手机深色主题及键盘单选切换。

## JSON 用量查询接口（2026-10-26）

- `GET /info`（兼容 `/info/`）复用公开面板的缓存与字段白名单，返回 `accounts`、`summary` 和 `interval_minutes`，包括已停用账号的最后观测。不会发起上游刷新或返回渠道凭据。
- `GET /api/admin/info-settings` 返回 `require_password` 与 `password_configured`；`PATCH` 接收 `require_password` 与可选 `password`，需要管理员会话及 CSRF。旧配置默认免密，首次启用密码必须提供密码；空值保留原密码，关闭密码模式后仍保留摘要。
- 查询密码与管理密码、MCP 令牌独立，以带随机盐的 PBKDF2 摘要持久化。校验在线程中执行，异步锁保护并发限流；同一来源 15 分钟内累计 5 次失败后返回 429。
- `/info` 中间件在路由前提取密码并清空 ASGI 查询字符串，成功和错误响应均带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。真实 Uvicorn 日志测试覆盖正确密码、认证失败、错误路径和未知查询参数；外部代理仍需自行避免记录查询字符串。
- 验证：115 项后端测试、37 项前端测试、Ruff 与生产构建通过。独立数据目录完成桌面和 390px 手机后台验收，覆盖免密、首次密码校验、正确与错误密码、留空保留、轮换及刷新后不回显。实际本地预览 `/info` 返回现有 4 个账号的缓存数据。

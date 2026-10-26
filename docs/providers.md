# 渠道与凭据说明

每个账号应使用独立别名和凭据。添加前在对应服务确认当前套餐及账户地区。凭据在本机管理后台录入并保存在 Docker 数据卷中；不要把凭据发给他人或写入 issue、日志和仓库。

部分渠道没有稳定公开的用量 API，当前适配可能使用控制台或客户端所调用的接口。供应商可随时调整协议、字段和认证要求。表中标注的方式以版本实现为准；真实账号验证状态应在渠道完成联调后更新。此处的验证记录用于说明开发阶段的渠道适配核验情况，不代表部署中某个账号的采集状态；首页以账号状态和更新时间展示实际采集结果。

| 渠道 | 计划支持的凭据 | 预期指标 | 样本解析测试 | 真实账号验证 |
|---|---|---|---|---|
| MiniMax | Coding Plan API Key；可选控制台 Cookie | 套餐窗口额度、剩余比例、重置时间 | 通过 | API Key 查询已验证；Cookie 尚未验证 |
| 智谱 GLM | Coding Plan API Key | 短周期 5h 与长周期 week 额度；额度接口返回时显示 MCP 调用总额和联网搜索、网页阅读、仓库检索已用次数 | 通过 | 尚未实测 |
| Kimi | API Key 或控制台 Cookie／JWT | 短周期 5h 与长周期 week 用量、已用比例、各自重置时间 | 通过 | API Key 计数型响应查询已验证；Cookie／JWT 尚未验证 |
| DeepSeek | API Key | 账户余额、赠送余额、充值余额及币种 | 通过 | 尚未实测 |
| 火山引擎 | Access Key ID 与 Secret Access Key | Coding Plan 用量、额度及周期 | 通过 | 尚未实测 |
| 阿里云百炼 | 控制台 Cookie／会话凭据 | Coding Plan 用量、额度及周期 | 通过 | 尚未实测 |
| Codex | 用户导入的 OAuth 凭据 | 订阅窗口剩余额度和重置时间 | 通过 | 尚未实测 |
| Claude | OAuth 凭据或会话 Cookie | 会话、周额度及接口提供的专项窗口 | 通过 | 尚未实测 |
| Cursor | 控制台 Cookie／会话凭据 | 套餐消费、额外消费、账单周期 | 通过 | 尚未实测 |
| OpenCode | Go API Key；Console Cookie＋工作空间 ID | Go 订阅的短周期 5h、长周期 week、月度 month；Cookie 方式另可读取预付费 USD 余额 | 通过 | 尚未使用真实凭据核验 |
| Google Antigravity | 用户导入的 OAuth 凭据 | 按模型的剩余额度及重置时间 | 通过 | 尚未实测 |

样本解析测试使用测试夹具，不等同于真实供应商账号验证。当前 11 个渠道的样本解析用例均通过；MiniMax API Key、Kimi API Key 的实际用量查询已通过真实接口验证。

## OpenCode

OpenCode 在本面板中指 `opencode.ai` 提供的 Go 订阅和 Console 预付费余额。通过 OpenCode 使用其他厂商的模型时，请在对应厂商渠道中配置账号。

**API Key 方式（Go 订阅）**

1. 登录 [OpenCode Console](https://opencode.ai/console)，确认自己的 Go 订阅可用。
2. 从账号菜单进入 Account／账户设置，创建或复制 Go 使用的 API Key。普通工作空间 Keys 页面生成的密钥可能不具有 Go 订阅权限；以官方页面实际权限为准。
3. 在本项目 `/admin` 添加渠道，选择“OpenCode → API Key”，填写别名和密钥，测试连接后保存。

该方式通过 `GET https://opencode.ai/inference/go/v1/usage`，使用 `Authorization: Bearer <Go API Key>` 查询。返回的 `percent` 是已用百分比，`0.5` 代表 `0.5%`；面板分别展示 `短周期 5h`、`长周期 week`、`月度额度 month`，支持已用／剩余切换和独立重置时间。API Key 用量接口不返回预付费余额，不从模型的估算请求数推算调用额度。

**Cookie 方式（Console 工作空间）**

1. 在已登录的 Console 中切换到需要查看的工作空间，打开 Go 或 Billing 页面。
2. 打开浏览器开发者工具的 Network／网络面板，找到 `/console/api/go/status` 请求，复制请求头中的完整 `Cookie` 和 `x-org-id`。Cookie 通常包含 `__Host-console_session`；请使用实际请求中的值，勿使用响应中的 `Set-Cookie`。
3. 在本项目选择“OpenCode → Cookie”，将这两项分别填入 Cookie 和“工作空间 ID”，测试连接后保存。不同工作空间分别添加账号，避免读错账户。

Cookie 方式读取同一工作空间的 Go 额度，并在接口支持时另列预付费 USD 余额；额度与余额不合计。余额支持零值和负值，账单信用额度不视为预付费余额。未订阅 Go 的预付费账户可仅显示余额；会话失效后需要重新导入 Cookie。

如果显示“订阅暂不可用”，请确认 Go 套餐、API Key 类型和工作空间是否匹配；这与凭据失效分别处理。当前已完成响应样本与错误处理测试，尚未获得真实 OpenCode 凭据进行结果核验。

## 获取方式提示

- **API Key：**登录服务商官方控制台，在 API Key／密钥管理页面创建；只授予查询用量所需的最低权限。DeepSeek 官方余额接口说明见[余额查询文档](https://api-docs.deepseek.com/api/get-user-balance/)。
- **火山引擎 AK/SK：**在火山引擎控制台的访问控制或密钥管理页面创建，并遵循服务商提供的最小权限策略。不要使用具有无关资源管理权限的主账号凭据。
- **Cookie／会话：**从本人已登录的官方控制台会话按管理页面提示复制。Cookie 等同临时密码，避免截图、分享或长期放在浏览器同步剪贴板中；失效后重新登录并更新。
- **OAuth 凭据：**仅导入自己账号、由受信任客户端或官方授权流程取得的凭据文件／字段。首版不提供网页登录授权流程。具备刷新令牌时适配器才可能自动续期；导入内容缺少刷新信息时，需要重新授权后更新。

管理页面应逐渠道显示当前版本要求的字段、获取说明和是否支持连接测试。不要把浏览器 Cookie 或 OAuth 文件上传到第三方“转换”网站。

## 指标口径

DeepSeek 当前按账户余额展示，不推断 Coding Plan 周期额度。余额注明币种；不同币种不合计。套餐额度按渠道返回的各个窗口分别展示，未知字段显示“暂无数据”。某些渠道只返回剩余量而不返回总量时，不应反推或虚构已用量。

历史趋势来自轮询时的观测快照，可能受渠道刷新延迟、窗口重置和采集间隔影响，不是精确调用日志或账单凭证。

GLM 的 MCP 调用次数来自官方控制台使用的未公开额度接口 `GET /api/monitor/usage/quota/limit`：`TIME_LIMIT` 行提供汇总额度字段，若包含 `usageDetails` 则显示其中明确返回的工具已用次数。智谱没有公开该接口的字段文档；解析依据脱敏响应样本（[CodexBar issue #2522](https://github.com/steipete/CodexBar/issues/2522)），字段可能变化。单工具额度上限和剩余次数未返回时保持未知，不从总额度分摊。

Kimi 的计数型响应中，`usage`（网页会话接口中的 `FEATURE_CODING.detail`）对应 7 天额度，`limits[].window` 的 `duration=300`、`timeUnit=TIME_UNIT_MINUTE` 对应 5 小时窗口；两个窗口分别读取自己的 `detail.resetTime`。接口保留原始额度数值和稳定指标 ID，页面与历史趋势展示已用百分比，不将额度整数标作调用次数。字段参照 [CodexBar Kimi 接口说明](https://github.com/steipete/CodexBar/blob/main/docs/kimi.md#api-details) 并已用本地配置的 API Key 账号核对。官方新旧会员可能具有不同周期，见 [Kimi 会员用量规则](https://www.kimi.com/en/help/membership/membership-update-rules)；本次验证范围为该账号返回的 `usage/limits` 结构，不代表纯比例版响应或所有会员类型已验证。

## 参考实现与文档

- [AIMeter 渠道文档](https://github.com/bugwz/AIMeter/blob/main/docs/providers/README.md)
- [CodexBar 支持渠道说明](https://github.com/steipete/CodexBar/blob/main/docs/providers.md)
- [coding-plan-dashboard](https://github.com/margrop/coding-plan-dashboard)
- [codingplan-monitor](https://github.com/Spanky96/codingplan-monitor)

以上链接用于了解公开的功能和渠道现状，不保证其接口或说明适用于本项目当前版本。遵守各项目许可证；本项目不复制其大段代码或文档。

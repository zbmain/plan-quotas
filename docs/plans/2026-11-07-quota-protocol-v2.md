# 统一额度协议 V2 实施计划

> 当前参数规范（2026-11-07 后续调整）：四个只读工具只接受 `channel`，默认 `all`；历史按渠道返回全部账号最近 24 小时。搜索只接受 `query/channel`，默认 `auto`，按后台顺序自动选择及故障切换账号。账号、状态、周期、工具类型、历史范围及搜索条数等输入均已移除。下文保留此前设计过程，当前调用方式以 [额度接口说明](../quota-api.md) 为准。

**目标：**直接替换 `/info` 与 MCP 额度查询的对外协议，用易读字段表达每个账号的真实额度，保留采集、页面、余额、历史与搜索能力。

**方案：**采集模型、加密文件和页面内部接口保持原结构；增加纯数据投影模块，统一生成 `/info` 与 MCP 的响应。用户已选择直接替换，不保留旧 JSON 别名和旧 MCP 额度参数。

## 协议

- 顶层只有 `version: 2`、`updatedAt`、`refreshIntervalSeconds`、`summary`、`accounts`，不重复返回 `list`。
- 账号字段：`id/name/channel/planName/status/isValid/invalidMessage/updatedAt/token/tools/balances`。
- `name` 是管理员配置的账号别名，`channel` 是稳定渠道代码；显示名称由页面渠道目录提供，不在每个账号中重复返回。
- 额度共同字段：`id/name/period/total/used/remaining/unit/resetAt`。数值未知时为 `null`，零保持零。
- 工具在需要时附加 `tool/shared/sharedWith/extra`；共享池只计一次，独立搜索次数未知时不推算。
- 金额统一通过 `unit` 标明币种；`balances` 另含 `kind: balance|cost`，避免把消费当余额。
- 仅提供百分比的观测，统一为 `%`、标尺 100，保留实际已用比例；不冒充 Token 数。
- `isValid` 表示最新采集成功、账号启用且数据新鲜；不表示额度大于零，也不推测套餐是否续费。无效时保留最后成功数据，提供安全中文 `invalidMessage`。
- 汇总按渠道、套餐、指标、真实单位、周期和重置时间分组。百分比、共享引用、无效与未知观测不计入总额，并返回跳过数量。
- 所有时间统一为 UTC ISO 8601；采集间隔明确以秒返回。

## 查询工具

- `list_accounts(channel, status)`：新字段的账号目录，包含搜索能力与开关。
- `get_token_quota(channel, accounts, period)`：模型/套餐额度及余额，默认查询全部。
- `get_tool_quota(channel, accounts, period, tool)`：工具额度及其必需的共享池上下文。
- `get_history(account, channel, time_range)`：相同额度字段的历史观测，保留缺测和重置标记。
- `web_search`：现行搜索功能及公开参数保持。

`accounts` 支持完整别名或 ID，保留多选、同名提示和严格参数检查。旧 `quota_period/tool_name/provider/account_ids/window` 等隐藏兼容参数移除，客户端应刷新工具列表。`/info` 仍为读取缓存的 GET 接口，仅使用既有独立密码认证，不执行脚本、搜索或刷新。

## 实施步骤

1. 新建 `quota_protocol.py`：白名单投影、时间与单位转换、共享关系、状态和汇总。
2. 在 `QuotaService` 增加对外统一查询与历史投影；页面内部的数据服务不迁移。
3. 将 `/info` 和 MCP 额度工具改为统一投影，简化 MCP 输入模型与参数解析。
4. 更新后台 MCP 示例、README 和开发说明，提供字段映射和新协议示例。
5. 补充协议测试，更新旧接口断言：真实单位、多周期、零值、未知、超额、共享池、无效/过期、余额、过滤、历史、密码及脱敏。
6. 运行后端/前端测试、格式检查、生产构建，使用官方 MCP 客户端核对查询；更新本地 Docker，保留 6 个账号和数据卷，并检查后台示例与原卡片。

## 完成记录

后续精简：按用户要求移除 `summary.totals` 和 `summary.skipped`，并将四个账号计数直接放到最外层：`accountCount/healthy/low/errors`，不再嵌套 `summary`。`accountCount` 与 `accounts` 清单区分。HTTP 与 MCP 同步调整，账号内的具体额度及 `total` 保持原样；当前说明见 [quota-api.md](../quota-api.md)。

以上步骤已完成。335 项后端测试、50 项前端测试、Ruff、Prettier、生产及 Docker 构建通过。本地容器健康，6 个账号和采集设置保留；官方 MCP 客户端核对额度与 HTTP 一致，历史查询和旧参数拒绝正常，未执行实际搜索。Ego 验收后台中文示例、复制提示与桌面/手机布局。调用与迁移说明位于 [quota-api.md](../quota-api.md)。

## 参考

- [CC Switch 额度查询字段说明](https://github.com/farion1231/cc-switch-website/blob/main/public/docs/en/2-providers/2.5-usage-query.md)
- [CC Switch 接入协议说明](https://github.com/farion1231/cc-switch/blob/main/docs/guides/deeplink-site-integration-guide-zh.md)

参考其结果字段；当前任务不引入自定义请求 URL、JavaScript extractor 或沙箱执行。`false`、`0`、`null` 分别保留真实含义，不使用 `value || true` 之类的默认逻辑。

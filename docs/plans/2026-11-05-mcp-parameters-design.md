# MCP 参数易读性设计

> 当前参数规范（2026-11-07 后续调整）：四个只读工具只接受 `channel`，默认 `all`；历史按渠道返回全部账号最近 24 小时。搜索只接受 `query/channel`，默认 `auto`，按后台顺序自动选择及故障切换账号。账号、状态、周期、工具类型、历史范围及搜索条数等输入均已移除。下文保留此前设计过程，当前调用方式以 [额度接口说明](../quota-api.md) 为准。

状态：已于 2026-11-06 实现，工具 ID 与输出契约保留。客户端需重新连接或刷新工具列表获取新参数 Schema。

## 设计目标

让管理员在 MCP 客户端里能看懂字段、选择渠道、直接填写账号别名；智能体仍使用稳定的英文参数名和标准 JSON 调用。

目前 `tools/list` 的实际结果表明：工具没有中文 `title`，参数没有说明与示例，可选参数普遍生成 `anyOf: [string, null]`。截图中的 `Provider option 1`、`Status option 2` 与这些类型分支一致，它们不是业务选项。

推荐保留现有五个工具 ID，增加中文工具标题、中文参数标题、简短说明和例子；参数改为单一类型，明确默认值。工具参数保持一层 JSON，不再套一层 `params`、`filters` 或 JSON 字符串。客户端自身的 JSON-RPC 请求封装仍按 MCP 协议处理。

备选方案包括只添加说明、完全改为中文参数名。只加说明无法解决类型分支和必须填写 UUID 的问题；中文参数名便于手填，但不利于已有脚本迁移。因此采用英文键名加中文界面元数据。

## 参数命名

| 现有参数 | 建议参数 | 中文标题 | 输入与默认值 |
|---|---|---|---|
| `provider` | `channel` | 渠道 | 查询默认 `all`；搜索默认 `auto` |
| `account_ids` | `accounts` | 账号（可多个） | 账号别名或 ID 的数组；默认 `[]`，查询全部符合条件的账号 |
| `account_id` | `account` | 账号 | 单个别名或 ID；历史查询必填，搜索可省略或填空字符串 |
| `window` | `quota_period` | 额度周期 | 默认 `all`；常用 `5h`、`week`、`month` |
| `tool` | `tool_name` | 工具额度类型 | `all`、`mcp`、`web_search`；默认 `all` |
| `range` | `time_range` | 历史时间范围 | `24h`、`7d`、`30d`；默认 `24h` |
| `status` | `status` | 账号状态 | 明确的状态下拉，默认 `all` |
| `query` | `query` | 搜索内容 | 必填，1～4000 字符；不能只有空白 |
| `max_results` | `max_results` | 最多返回几条结果 | 1～10 的整数，默认 10 |

不使用 `null` 作为表单选项。可选字段通过默认值和非必填标记实现：渠道与状态用单一字符串枚举，账号用字符串或字符串数组，数量用带上下限的整数。

`quota_period` 仍为字符串：常用值写入说明和 `examples`，也允许复制渠道结果中实际提供的其他周期。不能用一个封闭的常用周期列表屏蔽渠道的特殊额度窗口。`time_range` 则是固定枚举，与额度重置周期明确区分。

## 工具定义

| 工具 ID | 中文标题 | 参数 |
|---|---|---|
| `list_accounts` | 查看账号列表 | `channel="all"`、`status="all"` |
| `get_token_quota` | 查看套餐额度 | `channel="all"`、`accounts=[]`、`quota_period="all"` |
| `get_tool_quota` | 查看工具额度 | `channel="all"`、`accounts=[]`、`tool_name="all"`、`quota_period="all"` |
| `get_history` | 查看用量历史 | `account` 必填、`channel="all"`、`time_range="24h"` |
| `web_search` | 联网搜索 | `query` 必填、`channel="auto"`、`account=""`、`max_results=10` |

只有“用量历史”的账号和“联网搜索”的搜索内容必填。前三个查询工具传 `{}` 即可使用。

渠道查询值：`all`、`minimax`、`glm`、`kimi`、`deepseek`、`volcengine`、`aliyun`、`codex`、`claude`、`cursor`、`opencode`、`antigravity`。搜索渠道仅为 `auto`、`glm`、`minimax`。中文说明列出渠道显示名，其中 `glm` 对应 `GLM`。

账号状态值及说明：`all` 全部、`ok` 采集成功、`pending` 等待采集、`auth_required` 认证失效、`rate_limited` 请求限流、`error` 请求失败、`disabled` 已暂停、`stale` 数据过期。`ok` 保持现有“最近采集成功”的含义，不保证缓存仍新鲜；`stale` 专门筛选已启用且数据过期的账号。数据时效与采集状态是两个维度，可能重叠；不因重命名改变既有状态过滤含义。

固定枚举直接使用 `type: string` 与 `enum`，不为中文选项名称增加 `oneOf`／`anyOf` 分支。字段标题与说明是否显示取决于客户端；即使不显示，英文键和枚举值也应能独立理解。

## 账号选择规则

1. 先按渠道缩小范围，再解析账号 ID 或完整别名。
2. ID 精确匹配优先，其次按别名完全匹配；不做模糊匹配，不按排序猜测同名账号。
3. 同名时返回中文错误和公开候选列表（渠道、别名、ID），提示指定渠道或使用 ID。没有匹配时直接报错。
4. 多账号使用 JSON 数组，例如 `{"accounts":["工作账号","备用账号"]}`；不使用逗号分隔字符串。任意元素不存在或有歧义，整次请求失败，避免静默遗漏。
5. 账号别名不占用 `all`、`auto` 等保留字：查询全部由空数组表达，搜索自动选账号由省略 `account` 或空字符串表达。
6. 历史查询新增可选 `channel` 以区分不同渠道下的同名账号；结果仍只对应一个账号。

## 搜索与工具额度规则

- 只传 `query`：在管理员已开启的搜索账号中按清单顺序尝试，成功即停止；正常空结果也是成功。
- 指定 `channel`：只在该渠道内尝试，不切换其他渠道。
- 指定 `account`：只调用该账号，不切换其他账号；同时指定渠道时必须匹配。
- 搜索说明明确写出“会消耗所选账号套餐额度”，`max_results` 是上限，不保证一定返回该数量。
- `get_tool_quota(channel="glm")` 返回 GLM 官方 MCP 总池；选择 `tool_name="web_search"` 时仍返回明确标注的共享总池，不暗示它是搜索独占次数。
- MiniMax 独立搜索次数保持未知；保留共享套餐窗口关系。查询工具不执行搜索。

## 填写示例

以下均是工具的参数对象，工具名由客户端选择。

查询所有账号：`list_accounts`

```json
{}
```

查询 GLM 的短周期套餐额度：`get_token_quota`

```json
{"channel":"glm","quota_period":"5h"}
```

查询 GLM 的 MCP 月度总用量：`get_tool_quota`

```json
{"channel":"glm","tool_name":"mcp","quota_period":"month"}
```

查看指定账号最近七天的历史：`get_history`

```json
{"channel":"glm","account":"工作账号","time_range":"7d"}
```

按默认顺序联网搜索：`web_search`

```json
{"query":"Python asyncio 官方文档"}
```

指定 MiniMax 搜索，最多返回五条：`web_search`

```json
{"query":"Python asyncio 官方文档","channel":"minimax","max_results":5}
```

## 字段说明示例

`web_search.channel`：

```json
{
  "type":"string",
  "title":"搜索渠道",
  "description":"auto：按后台账号顺序尝试；glm：仅使用 GLM；minimax：仅使用 MiniMax。成功即停止。",
  "enum":["auto","glm","minimax"],
  "default":"auto",
  "examples":["auto","glm"]
}
```

`get_history.account`：标题“查询哪个账号”，说明“填写账号完整别名或 list_accounts 返回的 ID；重名时请同时选择渠道”，示例“工作账号”。

## 兼容与验收

- 工具 ID 和输出结构保留；本次只重新组织输入参数和元数据。`/info.accounts` 已按 2026-11-06 的后续要求单独升级为与 `list` 一致的新版格式。
- 旧 `provider/account_ids/account_id/window/tool/range` 在调用入口先归一为新参数，但不再展示为重复表单字段。旧名称的 `null` 按原含义处理，新表单无需填写 `null`。兼容旧 `account_ids:[]` 表示空选择；新 `accounts:[]` 表示全部，两者显式同时提供时属于含义冲突。
- 新旧参数同时提供时，先比较归一后的含义；不一致则返回中文冲突说明，不静默覆盖。需保留“省略”与“显式填写默认值”的区别。
- 参数错误说明字段、可选值及示例，不回显凭据；MCP 工具错误按既有协议返回，不输出堆栈。
- 更新后台工具说明与 README 参数示例；客户端修改后需重新连接或刷新工具列表才能获取新版 schema。
- 验收覆盖五个工具的默认调用、中文元数据、无 nullable 类型分支、别名／ID／同名处理、新旧参数兼容、冲突拒绝、周期与历史范围区分、搜索路由与结果数量边界。
- 使用实际客户端检查 `tools/list` 的渲染；不能仅凭 schema 已修改就断言所有客户端都显示中文下拉。

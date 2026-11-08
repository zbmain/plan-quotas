# 额度接口使用说明（V2）

HTTP `/info` 和 MCP 的套餐、工具额度查询共用一套返回格式。所有额度查询只读取已采集的缓存；只有 `web_search` 会调用供应商并消耗搜索额度。

## 快速查询

查看全部已启用账号：

```sh
curl 'http://127.0.0.1:8000/info'
```

如果管理员开启了密钥访问，使用已申请的任一有效 Token 访问 `/info` 和 `/mcp`：

```sh
curl -H 'x-api-key: YOUR_API_KEY' 'http://127.0.0.1:8000/info'
```

也支持 `?x-api-key=...`，建议优先使用请求头。**原 `apikey` 请求头和查询参数不再鉴权**，现有 API、MCP 客户端需要同步修改配置；已创建的 Token 无需更换。同时传入请求头和查询参数时，两者必须一致，同名字段重复时拒绝。最多申请 5 个 Token，后台默认隐藏、可查看和撤销；旧 `password` 与 `X-API-Password` 不再鉴权。Token 与管理员登录密码独立；渠道密钥、工作区等认证材料不在结果中返回。

## 返回格式

下面是说明结构的示例，不代表真实账号数据：

```json
{
  "version": 2,
  "updatedAt": "2026-11-07T01:00:00Z",
  "refreshIntervalSeconds": 60,
  "accountCount": 1,
  "healthy": 1,
  "low": 0,
  "errors": 0,
  "accounts": [
    {
      "id": "公开账号 ID",
      "name": "工作账号",
      "channel": "kimi",
      "planName": "订阅计划",
      "status": "ok",
      "isValid": true,
      "invalidMessage": null,
      "updatedAt": "2026-11-07T01:00:00Z",
      "token": [
        {
          "id": "short",
          "name": "短周期",
          "period": "5h",
          "total": 100,
          "used": 12,
          "remaining": 88,
          "unit": "%",
          "resetAt": null
        }
      ],
      "tools": [],
      "balances": []
    }
  ]
}
```

`accounts` 按管理后台的顺序排列，只包含已启用账号（包括异常账号）；已禁用账号不出现在 `/info` 或 MCP 结果中，但仍在网页面板中显示。`updatedAt` 是最近一次成功采集时间；顶层取账号中最新的成功时间，没有成功记录时为 `null`。时间统一为 UTC。`refreshIntervalSeconds` 是后台采集间隔，不是浏览器刷新间隔。

### 账号与状态

| 字段 | 含义 |
|---|---|
| `id`、`name` | 账号 ID 与管理员填写的公开别名 |
| `channel` | 统一渠道标识，如 `glm`、`kimi`、`opendesign`；查询参数也使用相同值 |
| `planName` | 渠道返回的套餐名；未提供时为 `null` |
| `status` | `ok` 正常、`pending` 等待采集、`stale` 缓存过期、`auth_required` 认证失效、`rate_limited` 限流、`error` 采集失败 |
| `isValid` | 是否采集成功且未过期，**不代表供应商承诺套餐有效** |
| `invalidMessage` | 无效时的脱敏中文说明，正常时为 `null` |
| `token` | 模型套餐额度；单位以每条记录的 `unit` 为准 |
| `tools` | 工具额度与共享关系 |
| `balances` | 余额或消费金额；不与套餐额度相加 |

失败或过期时仍保留最后成功的额度，但 `isValid=false`，不计入正常账号数。禁用账号不出现在接口结果中。首次采集前数组可以为空。

### 每条额度

| 字段 | 含义 |
|---|---|
| `id`、`name` | 指标 ID 与可读名称 |
| `period` | 套餐窗口：`5h`、`week`、`month`，或实际返回的其他时长；未知为 `null` |
| `total`、`used`、`remaining` | 总额、已用、剩余；未知为 `null`，真实零值为 `0` |
| `unit` | `%`、`tokens`、`额度`、`次`，或金额币种 `USD`、`CNY` 等 |
| `resetAt` | 上游提供的重置时间；未知为 `null`，不推算 |
| `extra` | 有必要时提供的补充说明；无说明时省略 |

仅有比例的模型额度使用 `unit:"%"`、`total:100`，这个 100 是百分比标尺。不会换算为绝对 Token 数；超额比例可大于 100。如果来源仅提供部分绝对数量及使用比例，可另返回 `usedPercent`，不会据此推算未知的总额。已知总额与另一计数能明确相减时，可补全已用或剩余值。

金额多一个 `kind` 字段：`balance` 是可用余额，`cost` 是消费金额。例如 DeepSeek 余额：

```json
{"id":"total-balance","name":"总余额","period":null,"total":null,"used":null,"remaining":125.37,"unit":"CNY","resetAt":null,"kind":"balance"}
```

### 工具共享额度

GLM 仅返回 MCP 总池。`tool:"mcp"`、`shared:true` 表明所有 MCP 工具共享，不返回搜索等单工具明细，也不重复相加：

```json
{"id":"glm-0","name":"MCP 调用次数","period":"month","total":4000,"used":216,"remaining":3784,"unit":"次","resetAt":null,"tool":"mcp","shared":true,"extra":"所有 MCP 工具共享此额度；不提供单工具独立次数。"}
```

MiniMax 未提供独立搜索计数，`total/used/remaining` 均为 `null`。`sharedWith` 引用同账号 `token` 数组中的指标 ID；工具查询会保留这些套餐窗口供查阅，引用关系不表示搜索有另一份可相加的额度：

```json
{"id":"minimax-web-search-5h","name":"联网搜索","period":"5h","total":null,"used":null,"remaining":null,"unit":"次","resetAt":null,"tool":"web_search","shared":true,"sharedWith":["short"],"extra":"共享套餐额度，独立用量暂无数据"}
```

### 汇总

最外层的 `accountCount/healthy/low/errors` 分别表示本次选中的账号数、数据正常数、额度紧张数及采集异常数。套餐或工具已用达到 80% 时计为额度紧张；钱包余额为零不会触发该判断。

不再返回 `summary`，统计字段直接放在最外层；账号数量使用 `accountCount`，避免与 `accounts` 清单重名。也不返回额度合计 `totals` 或排除诊断 `skipped`。各账号的具体额度统一读取 `accounts[].token/tools/balances`；每条额度的 `total` 仍表示该额度的总额。

## MCP 参数

连接 `/mcp` 后，选择工具并填写以下 JSON 参数。所有参数使用中文标题和说明；可选参数省略时使用默认值。

| 工具 | 参数示例 | 结果 |
|---|---|---|
| `list_accounts` | `{}` 或 `{"channel":"glm"}` | 该渠道已启用账号的公开信息数组，附 `order/searchSupported/searchEnabled` |
| `get_token_quota` | `{"channel":"glm"}` | 该渠道已启用账号、全部周期的模型额度和余额 |
| `get_tool_quota` | `{"channel":"glm"}` | 该渠道已启用账号、全部工具额度和必要的共享上下文 |
| `get_history` | `{"channel":"glm"}` | 该渠道已启用账号最近 24 小时的历史观测 |
| `web_search` | `{"query":"Python asyncio 官方文档","channel":"minimax"}` | 搜索结果，标明实际使用的账号和渠道，最多 10 条 |

四个查询工具**只接受 `channel`**，默认 `all`，传 `{}` 查询全部渠道；按后台顺序返回该渠道已启用账号，不支持账号、状态、周期、工具类型或历史范围筛选。历史固定为最近 24 小时。

搜索**只接受 `query/channel`**，`query` 必填，`channel` 默认 `auto`，也可选 `glm/minimax`。指定渠道时只在该渠道内按后台顺序切换账号；`auto` 按全部账号的后台顺序尝试。异常或不可用时尝试下一优先级账号，成功（含正常空结果）即停。最多返回 10 条，不接受 `account/max_results`。账号须已开启搜索，错误参数不会发起上游请求。

### 历史结果

```json
{
  "version": 2,
  "range": "24h",
  "accountCount": 1,
  "accounts": [
    {
      "id": "公开账号 ID",
      "name": "工作账号",
      "channel": "glm",
      "points": [
        {"time":"2026-11-07T01:00:00Z","isMissing":true,"isReset":false,"token":[],"tools":[],"balances":[]}
      ]
    }
  ]
}
```

`accounts` 按后台配置顺序返回，空渠道返回空数组。每个账号含独立 `points`，固定以 5 分钟时间桶的末次记录展示最近 24 小时。有观测时，额度项与当前查询同名；`isMissing` 标记缺测，`isReset` 标记观测到的重置。不会补造过去的工具调用次数，历史观测不代表精确消费账单。网页历史视图仍支持原有的 24 小时、7 天和 30 天选择。

### 参数错误

MCP 返回 `isError:true`，内容为 `{"errorCode":"invalid_parameters","message":"中文说明"}`，必要时包含 `field`。未知和已移除的参数均拒绝，不会忽略后继续执行。不回显原始输入。刷新客户端工具列表可获得当前参数。

## 从旧协议迁移

本次直接替换，不提供旧返回格式或旧参数名兼容。

| 原位置或参数 | V2 |
|---|---|
| `/info.list`、额度 MCP `list` | `accounts`，仅保留一份清单 |
| `provider`、`alias` | `channel`、`name` |
| `channelName` | 已移除；HTTP、MCP 和历史结果统一只保留 `channel` |
| `updated_at`、`interval_minutes` | `updatedAt`、`refreshIntervalSeconds`（分钟改秒） |
| `enabled/status/stale` 判断 | `status` 与 `isValid` |
| `label/window/limit/resets_at` | `name/period/total/resetAt` |
| `currency` | 金额的 `unit` |
| 仅比例的 `used_percent` | `used`，且 `unit:"%"`、`total:100` |
| `quota_scope/shared_quota_ids/note` | `shared/sharedWith/extra` |
| `summary.totals`、`summary.skipped` 及旧汇总数组 | 已移除；具体额度读取账号内的 `token/tools/balances` |
| `summary.accounts/healthy/low/errors` | 最外层的 `accountCount/healthy/low/errors`，移除 `summary` |
| MCP 查询 `accounts/account/status/period/tool/time_range` 及旧筛选参数 | 已移除，四个查询工具只接受 `channel` |
| MCP 搜索 `account/max_results` | 已移除，只接受 `query/channel` |
| MCP 单账号历史 `account/points` | 改为 `accounts` 数组，每个账号包含 `id/name/channel/points`，固定最近 24 小时 |
| MCP 历史 `timestamp/gap/reset/metrics` | `time/isMissing/isReset/token+tools+balances` |

现有账号、采集设置、加密凭据及历史文件继续保留。接口鉴权统一改为 `x-api-key` Token：原免密实例保持免密，原密码保护实例保持受保护状态，管理员申请 Token 后更新客户端。公开页面与管理页面继续工作，无需配置自定义请求地址或执行脚本。

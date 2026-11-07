# plan-quotas

plan-quotas 是一个自托管的 AI Coding Plan 用量面板。它把多个模型渠道的套餐额度、余额、重置时间和最近用量变化放在同一个页面查看，适合个人和小团队部署在自己的电脑或服务器上。

公开首页无需登录。管理员通过 `/admin` 登录后添加渠道账号、配置凭据、检查连接并管理采集。用量数据从添加账号后开始积累；面板展示的是渠道提供的额度或余额，以及定时采集到的变化，不是精确的 Token 账单。

账号清单默认按已用量展示，可通过“显示方式”单选器切换为按剩余量展示。卡片主数值、进度条和历史趋势会同步切换；无法计算的额度显示“暂无数据”，账户余额与费用仍保留金额含义。

页面宽度不超过 850px 时隐藏账号搜索，渠道和状态筛选仍可使用；切换到窄屏时会清空搜索词。

点击首页页脚的蓝色秒数可切换页面刷新间隔，从 30 秒到 180 秒循环。该设置只控制当前页面读取缓存的频率；渠道采集周期在管理面板配置。重新打开页面时恢复 30 秒。

首页可按“可用／不可用”筛选，顶部统计使用相同规则：套餐账号实际返回的各模型周期均有剩余额度才算可用，任一周期耗尽即不可用；DeepSeek 按可用总余额判断。工具额度和套餐钱包不参与模型周期判断。暂停、采集异常、数据过期或额度未知的账号归入不可用。

自动采集遇到网络错误或超时时，会在首次失败后重试 3 次，仍失败才标记采集异常；重试期间保留已有数据。认证失效和限流按各自规则处理。

支持 MiniMax、GLM、Kimi、DeepSeek、火山引擎、阿里云百炼、Codex、Claude、Cursor、OpenCode、OpenDesign 和 Google Antigravity。各渠道支持的认证方式和可用指标不同，详见[渠道与凭据说明](docs/providers.md)。

首页卡片、后台账号列表和新增渠道窗口统一展示品牌图标，支持深浅主题。图标随部署包提供，页面不依赖外部图标服务。

全站采用统一的翡翠绿界面，支持浅色、深色和跟随系统。账号概览为一体式三分栏，手机端也保持单行；加载与缺失数据分别显示占位和“—”。字体随部署包提供，动效遵循系统的减少动态效果设置。设计与验收结果见[界面升级记录](docs/plans/2026-11-07-visual-redesign.md)。

## 快速部署

需要已安装 Docker Engine 或 Docker Desktop，并启用 Docker Compose。下载或克隆本项目后，在项目目录执行：

```sh
cp .env.example .env
```

编辑 `.env`，建议将 `ADMIN_PASSWORD` 改为自己的密码，然后启动：

```sh
docker compose up -d --build
```

默认仅监听本机 `127.0.0.1:8000`。打开 `http://127.0.0.1:8000` 查看面板，访问 `http://127.0.0.1:8000/admin` 登录管理后台。健康状态可通过 `/healthz` 查看。

默认管理员密码是 `admin`。建议部署后更换默认密码。

也可以直接使用 Docker 启动：

```sh
docker build -t plan-quotas:local .
docker run -d --name plan-quotas --restart unless-stopped \
  --env-file .env -e DATA_DIR=/app/data -e STATIC_DIR=/app/frontend/dist \
  -p 127.0.0.1:8000:8000 -v plan_quotas_data:/app/data \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true plan-quotas:local
```

不用 Docker 时，请先安装 Node.js 26，在项目根目录运行 `npm ci`、`npm run build`，再执行 `npm start -- --host 127.0.0.1 --port 8000`。数据默认保存在 `./data`，请将该目录与网站静态资源分开保管。

## 局域网与 HTTPS 访问

需要从局域网其他设备访问时，在 `.env` 中设置：

```dotenv
BIND_HOST=0.0.0.0
ALLOWED_HOSTS=localhost,127.0.0.1,[::1],服务器局域网IP
```

然后执行 `docker compose up -d`。

使用域名访问时，在前方配置 HTTPS 反向代理；在 `.env` 中将 `COOKIE_SECURE=true`、`PUBLIC_ORIGIN=https://你的域名`，并把域名加入 `ALLOWED_HOSTS`。重启容器使设置生效，远程 MCP 客户端也使用 HTTPS 地址。

## 添加渠道账号

1. 打开 `/admin`，使用 `ADMIN_PASSWORD` 登录。
2. 选择渠道，填写便于识别的账号别名和该渠道要求的认证资料。
3. 点击“测试连接”，确认渠道返回有效数据后保存。
4. 等待首次采集完成；之后首页会定时更新，并逐步积累历史趋势。

不同渠道可能要求 API Key、Cookie／会话凭据、OAuth 凭据、云服务 AK/SK 或账户凭据（Control Key）。具体入口、权限和注意事项见[渠道与凭据说明](docs/providers.md)。凭据只在提交时输入，管理页面不提供原文回显。请只添加自己有权使用的账号，并确保 Docker 数据卷受到保护。

添加 OpenCode 时，使用 OpenCode Go API Key 查询订阅的 `5h`、`week`、`month` 额度；使用 Cookie 方式时，还需填写 Console 工作空间 ID，可额外查询预付费账户余额。获取步骤见 [OpenCode 配置说明](docs/providers.md#opencode)。

添加 OpenDesign 时，可选择 **Cookie** 或“账户凭据（Control Key）”，两种方式都需填写个人工作区 ID。Cookie 从本人已登录的 Cloud 控制台账单请求中取得；Control Key 从已登录的官方 Vela 配置中手动取得，模型 API Key 不能查询套餐额度。支持个人 Go／Plus／Pro／Max 套餐，卡片按实际返回的窗口显示 `5h`、`week` 等额度，USD 钱包独立显示。会话或凭据失效后需重新登录官方账户并更新。具体步骤见 [OpenDesign 配置说明](docs/providers.md#opendesign)。

管理后台可以编辑账号、启停采集、手动刷新、调整采集间隔和删除账号。自动采集默认每 1 分钟一次，可选择每 30 秒、1 分钟、2 分钟或 5 分钟；已有部署会保留此前保存的周期，可在后台重新选择。首页每 30 秒检查一次已采集的数据，不会因此额外请求渠道。删除会一并清除该账号保存的凭据、缓存和历史记录。采集过于频繁可能触发渠道限流。

在“页面设置”中修改“页面标题”并保存，即可更新首页和管理后台的浏览器标签页标题；留空会恢复默认标题。标题最多 120 个字符，保存在 `DATA_DIR/config.json` 中，刷新页面、重启服务或迁移完整数据目录后仍然有效。

## HTTP JSON 用量接口

使用 `GET /info` 获取所有已配置渠道账号的最新用量 JSON，包括已暂停账号。默认允许免密码访问：

```sh
curl 'http://127.0.0.1:8000/info'
```

在 `/admin` 的“访问权限”中申请 Token，再选择“需要密钥”并保存；`/info` 与 `/mcp` 共用这组 Token，任一有效 Token 都可以访问：

```sh
curl -H 'apikey: YOUR_API_KEY' 'http://127.0.0.1:8000/info'

curl --get --data-urlencode 'apikey=YOUR_API_KEY' 'http://127.0.0.1:8000/info'
```

每个实例最多保留 5 个随机生成的 `sk-` Token，一个 Token 可供多个客户端使用。默认隐藏，点击眼睛查看；可复制或撤销，撤销立即生效。Token 与管理员密码独立；公开仪表盘不受该开关影响。远程接入请使用 HTTPS，优先使用请求头，并让代理日志忽略查询字符串。

旧 `password`、`X-API-Password` 和共享接口密码已停用。原来开启密码保护的实例升级后仍要求密钥，管理员须申请 Token 并更新客户端，期间不会自动开放接口。

接口采用 **V2 协议**，只返回一份 `accounts` 账号清单，另提供 `version`、`updatedAt`、`refreshIntervalSeconds` 和四个账号统计字段。每个账号用 `name` 表示公开别名、`channel` 表示唯一渠道标识（如 `glm`、`opendesign`）、`planName` 表示套餐，额度分为 `token`（模型套餐）、`tools`（工具）和 `balances`（余额或消费金额）。接口不再重复返回渠道显示名，查询参数也使用同一个 `channel`。

账号统计直接位于最外层：`accountCount`（账号数）、`healthy`（正常数）、`low`（额度紧张数）、`errors`（异常数）。不再嵌套 `summary`，`accounts` 始终表示账号清单；具体额度在各账号中查看，不重复返回额度合计和跳过统计。

每条额度统一使用 `name / period / total / used / remaining / unit / resetAt`，例如：

```json
{"id":"short","name":"短周期","period":"5h","total":100,"used":12,"remaining":88,"unit":"%","resetAt":null}
```

`isValid` 表示当前数据采集成功且未过期，失效说明见 `invalidMessage`。未知值为 `null`，零值保持 `0`；仅有百分比的套餐以 `%` 为单位，不换算为虚构的 Token 数。金额用 `USD`、`CNY` 等币种表示，工具共享额度标注 `shared` 和必要的 `sharedWith`。接口只读取缓存，不执行搜索或额外采集，也不受页面“已用量／剩余量”切换影响。

**升级需更新调用方**：已移除重复的 `list`，`provider/alias/window/limit/resets_at` 分别改为 `channel/name/period/total/resetAt`；`updated_at` 改为 `updatedAt`，采集间隔改为秒。MCP 额度查询也使用这套结果。完整字段、汇总口径及迁移对照见[额度接口使用说明](docs/quota-api.md)。

密钥模式下，缺少或错误 Token 返回 `401`；连续验证失败可能返回 `429`。撤销全部 Token 后仍保持密钥模式，直至管理员生成新 Token 或明确切换免密。

## 远程 MCP

MCP 通过 `/mcp` 提供 Streamable HTTP 连接，与 `/info` 共用访问 Token。默认免密；启用密钥访问后，客户端通过 `apikey` 请求头认证。后台“MCP 接入”的“配置示例”按钮可展开并复制 `mcp.json` 模板。

客户端连接地址为 `https://你的域名/mcp`。例如，支持自定义请求头的客户端可配置：

```json
{
  "mcpServers": {
    "plan-quotas": {
      "url": "https://你的域名/mcp",
      "headers": {"apikey": "YOUR_API_KEY"}
    }
  }
}
```

接口免密时可省略 `headers`。也支持 `?apikey=...`；请求头与查询参数同时提供时必须一致，同名请求头或查询参数不允许重复。MCP 提供以下工具：

| 工具 | 中文名称与参数 |
|---|---|
| `list_accounts` | 查看账号列表：只接受 `channel`，默认 `all`（全部渠道） |
| `get_token_quota` | 查看套餐额度和余额：只接受 `channel`，返回所选渠道全部账号、全部周期 |
| `get_tool_quota` | 查看工具额度：只接受 `channel`，返回所选渠道全部账号、全部工具额度 |
| `get_history` | 查看历史：只接受 `channel`，固定返回所选渠道全部账号最近 24 小时的记录 |
| `web_search` | 联网搜索：必填 `query`，可选 `channel`，默认 `auto`；不能指定账号或结果条数 |

额度查询使用最近一次采集的缓存，不会主动刷新渠道。搜索会消耗套餐额度；账号默认关闭搜索，需在管理后台逐账号开启。

选择对应工具后，只填写参数对象即可。四个查询工具直接传 `{}` 就能查询全部渠道，也可以使用 `{"channel":"glm"}` 限定渠道。返回该渠道全部账号，按后台顺序排列；不能指定账号、状态、周期、工具类型或历史范围。

查看 GLM 所有账号、所有周期的套餐额度（`get_token_quota`）：

```json
{"channel":"glm"}
```

查看 GLM 所有账号的工具额度（`get_tool_quota`）：

```json
{"channel":"glm"}
```

查看 GLM 所有账号最近 24 小时的历史（`get_history`）：

```json
{"channel":"glm"}
```

联网搜索只需 `{"query":"Python asyncio 官方文档"}`。指定 MiniMax（`web_search`）：

```json
{"query":"Python asyncio 官方文档","channel":"minimax"}
```

四个查询工具的 `channel` 默认 `all`。搜索默认 `auto`，按全部账号的后台顺序尝试；选择 `glm` 或 `minimax` 时，仅在所选渠道中按后台顺序尝试。搜索最多返回 10 条实际结果，不能指定账号或结果条数。

结果中的 `status` 表示 `ok`（数据正常且未过期）、`pending`（等待采集）、`auth_required`（认证失效）、`rate_limited`（限流）、`error`（请求失败）、`disabled`（已暂停）或 `stale`（最近成功的缓存已过期）。状态异常时仍保留最后一次成功的额度，`isValid` 为 `false`，不计入正常账号数。

管理后台的“工具参数与填写示例”提供说明和复制按钮。接口更新后，请在 MCP 客户端重新连接或刷新工具列表，获取中文标题、新参数名和默认值。

四个查询工具只允许 `channel`，包括 `accounts/account/status/period/tool/time_range` 在内的其他输入均已移除；搜索只允许 `query/channel`，不再接受 `account/max_results`。额外参数会被明确拒绝，不会悄悄忽略，也不会执行搜索。请重新连接 MCP 或刷新工具列表，更新客户端表单。

搜索目前支持 GLM 和 MiniMax 的套餐 API Key，Cookie 账号不能参与。`auto` 按全部账号的后台顺序尝试；指定渠道时，仅在该渠道内依序尝试。异常、限流、额度耗尽或不可用时使用下一优先级账号；成功即停止，包括没有搜索结果的正常响应。暂停或未开启搜索的账号不参与，重新启用后保留搜索开关。接口免密时，访问者可调用已开启的搜索账号并消耗套餐额度。

GLM 卡片、历史趋势、`/info.accounts` 和 MCP 额度工具统一只显示“MCP 调用次数”总池，不展示搜索、网页阅读、仓库检索等单项明细，不将共享总池当作搜索的独立额度。MiniMax 显示“共享套餐额度，独立用量暂无数据”。不统计本服务搜索次数来替代官方用量。

从旧版本升级时，原免密实例继续免密，原密码保护实例保持密钥模式，等待管理员申请 Token 并更新客户端；旧共享密码与 MCP Bearer Token 均失效。搜索沿用已保存的账号开关，新账号默认关闭。旧 `get_usage`、`get_summary` 工具替换为 `get_token_quota`、`get_tool_quota`。管理员登录密码、渠道凭据和历史记录不变。

## 数据、升级与备份恢复

Compose 使用名为 `plan_quotas_data` 的 Docker 命名卷保存配置、加密凭据、访问 Token（`api-access.enc`）、加密主密钥、当前用量和最多 30 天的历史快照。数据不放在 Web 静态目录中。容器以非 root 用户运行。迁移后访问文件损坏或缺失时服务拒绝启动，不自动恢复旧 Token 或开放接口。

升级时先执行 `docker compose stop`，备份完整数据，再在新版本项目目录执行：

```sh
docker compose up -d --build
```

同一数据卷只允许一个实例运行；从早期版本升级时，也必须先停止旧容器，再启动新版。现有账号凭据及历史记录继续保留；接口旧密码需替换为后台新申请的 Token。

**备份时必须同时保存整个数据目录和加密主密钥。** 缺少主密钥时，已加密的渠道凭据不能恢复。示例：

```sh
docker compose stop
docker run --rm -v plan_quotas_data:/data -v "$PWD/backups:/backup" alpine \
  tar -czf /backup/plan-quotas-data-$(date +%Y%m%d).tar.gz -C /data .
docker compose start
```

恢复时先停止服务，再将归档完整解压到数据卷，并恢复容器运行用户的文件权限：

```sh
docker compose stop
docker run --rm -v plan_quotas_data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'tar -xzf /backup/plan-quotas-data-YYYYMMDD.tar.gz -C /data && chown -R 10001:10001 /data'
docker compose start
```

将命令中的 `YYYYMMDD` 替换为备份文件日期。请妥善保管备份文件；其中包含可解密凭据所需的主密钥。数据卷固定命名为 `plan_quotas_data`。

彻底移除容器但保留数据：

```sh
docker compose down
```

同时删除数据卷会永久删除渠道配置、凭据和历史：

```sh
docker compose down -v
```

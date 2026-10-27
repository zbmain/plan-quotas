# plan-quotas

plan-quotas 是一个自托管的 AI Coding Plan 用量面板。它把多个模型渠道的套餐额度、余额、重置时间和最近用量变化放在同一个页面查看，适合个人和小团队部署在自己的电脑或服务器上。

公开首页无需登录。管理员通过 `/admin` 登录后添加渠道账号、配置凭据、检查连接并管理采集。用量数据从添加账号后开始积累；面板展示的是渠道提供的额度或余额，以及定时采集到的变化，不是精确的 Token 账单。

渠道清单默认按已用量展示，可通过“显示方式”单选器切换为按剩余量展示。卡片主数值、进度条和历史趋势会同步切换；无法计算的额度显示“暂无数据”，账户余额与费用仍保留金额含义。

支持 MiniMax、智谱 GLM、Kimi、DeepSeek、火山引擎、阿里云百炼、Codex、Claude、Cursor、OpenCode 和 Google Antigravity。各渠道支持的认证方式和可用指标不同，详见[渠道与凭据说明](docs/providers.md)。

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

不同渠道可能要求 API Key、Cookie／会话凭据、OAuth 凭据或云服务 AK/SK。具体入口、权限和注意事项见[渠道与凭据说明](docs/providers.md)。凭据只在提交时输入，管理页面不提供原文回显。请只添加自己有权使用的账号，并确保 Docker 数据卷受到保护。

添加 OpenCode 时，使用 OpenCode Go API Key 查询订阅的 `5h`、`week`、`month` 额度；使用 Cookie 方式时，还需填写 Console 工作空间 ID，可额外查询预付费账户余额。获取步骤见 [OpenCode 配置说明](docs/providers.md#opencode)。

管理后台可以编辑账号、启停采集、手动刷新、调整采集间隔和删除账号。自动采集默认每 1 分钟一次，可选择每 30 秒、1 分钟、2 分钟或 5 分钟；已有部署会保留此前保存的周期，可在后台重新选择。首页每 30 秒检查一次已采集的数据，不会因此额外请求渠道。删除会一并清除该账号保存的凭据、缓存和历史记录。采集过于频繁可能触发渠道限流。

在“页面设置”中修改“页面标题”并保存，即可更新首页和管理后台的浏览器标签页标题；留空会恢复默认标题。标题最多 120 个字符，保存在 `DATA_DIR/config.json` 中，刷新页面、重启服务或迁移完整数据目录后仍然有效。

## HTTP JSON 用量接口

使用 `GET /info` 获取所有已配置渠道账号的最新用量 JSON，包括已暂停账号。默认允许免密码访问：

```sh
curl 'http://127.0.0.1:8000/info'
```

在 `/admin` 的“用量 JSON 接口”中，可切换为“需要查询密码”，设置独立密码并保存。之后使用 `password` 查询参数访问；密码含中文或特殊字符时应进行 URL 编码：

```sh
curl --get --data-urlencode 'password=YOUR_PASSWORD' 'http://127.0.0.1:8000/info'
```

将 `YOUR_PASSWORD` 替换为后台设置的查询密码。它不复用管理员密码或 MCP 令牌；保存后不会回显，留空保存会保留原密码，填写新密码即可更换。访问方式只控制 `/info`，公开首页仍无需登录。

返回内容包含 `accounts`（账号别名、渠道、状态、用量指标、周期、重置时间与最后采集时间）、`summary`（账号状态汇总）和 `interval_minutes`（采集周期）。接口读取缓存，不触发额外采集，不返回渠道密钥、Cookie、OAuth 凭据或管理员配置。未知指标保留为 `null`，也不会受首页“已用量／剩余量”显示选择影响。

密码模式下，缺少或错误密码返回 `401`；连续验证失败可能返回 `429`。密码通过 URL 参数传递，远程部署时使用 HTTPS，并配置反向代理、网关等访问日志不记录查询字符串。

## 远程 MCP

MCP 通过 `/mcp` 提供 Streamable HTTP 连接。管理员在后台的 MCP 设置中生成令牌；令牌只在生成时显示一次，请立即复制到可信的 MCP 客户端配置中。遗失后可轮换令牌，旧令牌随即失效；不再需要时可撤销令牌。

客户端连接地址为 `https://你的域名/mcp`，认证方式为 Bearer Token。MCP 提供以下只读工具：

| 工具 | 用途 |
|---|---|
| `list_accounts` | 按渠道或状态查看账号别名和状态 |
| `get_usage` | 查询账号当前额度、余额、周期和数据有效性 |
| `get_summary` | 汇总正常、异常和额度紧张账号数量 |
| `get_history` | 查询账号最近 24 小时、7 天或 30 天的采集趋势 |

MCP 查询使用最近一次采集的缓存，不会主动调用渠道接口刷新。不得将令牌写入公开仓库、截图、日志或不可信客户端。

## 数据、升级与备份恢复

Compose 使用名为 `plan_quotas_data` 的 Docker 命名卷保存配置、加密凭据、加密主密钥、当前用量和最多 30 天的历史快照。数据不放在 Web 静态目录中。容器以非 root 用户运行。

升级时先备份数据，再在新版本项目目录执行：

```sh
docker compose up -d --build
```

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

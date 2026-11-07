# plan-quotas

自托管的 AI 套餐用量面板，集中查看多个渠道的额度、余额和历史变化。公开首页无需登录；管理员可添加账号、管理凭据和设置采集周期。

支持 MiniMax、GLM、Kimi、DeepSeek、火山引擎、阿里云百炼、Codex、Claude、Cursor、OpenCode、OpenDesign 和 Google Antigravity。各渠道的认证方式和指标见[渠道与凭据说明](docs/providers.md)。

## 快速开始

需要 Docker Engine 或 Docker Desktop，以及 Docker Compose。首次部署时，在项目目录运行（已有 `.env` 时请保留原文件）：

```sh
cp .env.example .env
```

编辑 `.env`，将 `ADMIN_PASSWORD` 改为自己的密码，按需设置 `DATA_DIR` 和 `PORT`，然后启动：

```sh
docker compose up -d --build
```

- 面板：[http://127.0.0.1:8000](http://127.0.0.1:8000)
- 管理后台：[http://127.0.0.1:8000/admin](http://127.0.0.1:8000/admin)
- 健康检查：[http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz)

默认仅允许本机访问，管理员默认密码为 `admin`。登录管理后台后添加渠道账号、测试连接并保存。渠道凭据只在提交时输入，后台不回显原文。

```sh
docker compose logs -f   # 查看日志
docker compose stop      # 停止服务
docker compose start     # 启动已停止的服务
docker compose down      # 移除容器，保留数据
```

## 配置与数据

`.env.example` 列出了可用配置。`DATA_DIR=./data` 将数据保存在项目的 `data/` 目录；也可填写宿主机绝对路径。若未设置 `DATA_DIR`，Compose 使用 `plan_quotas_data` 命名卷。容器内固定挂载到 `/app/data`，同一数据目录只能由一个实例使用。

数据目录包含账号配置、加密凭据、接口 Token、加密主密钥 `master.key` 和用量历史。**备份和迁移时请先停止服务，完整保存整个数据目录，包括 `master.key` 和隐藏文件**；缺少主密钥将无法恢复加密凭据。自定义项目内数据目录时，应同时将其加入 `.gitignore` 和 `.dockerignore`。

旧部署若使用 `CONFIG_DIR`，请先停止服务，将其值转移到 `.env` 中的 `DATA_DIR`，再删除 `CONFIG_DIR`。旧部署未设置 `CONFIG_DIR` 时，原数据位于 `plan_quotas_data` 命名卷，可设置 `DATA_DIR=plan_quotas_data` 继续使用。切换到其他目录前需先迁移完整数据，切换配置本身不会复制数据。

从旧命名卷迁移到空的 `./data` 目录：

```sh
docker compose stop
mkdir -p data
docker run --rm -v plan_quotas_data:/source:ro -v "$PWD/data:/target" alpine \
  sh -c 'tar -C /source -cf - . | tar -C /target -xf - && chown -R 10001:10001 /target'
```

之后设置 `DATA_DIR=./data` 并执行 `docker compose up -d --build`。确认账号和历史完整后再处理旧卷。容器以 UID/GID `10001:10001` 运行，宿主机目录需允许容器读写。

局域网访问需设置 `BIND_HOST=0.0.0.0`，并将服务器地址加入 `ALLOWED_HOSTS`。使用域名时，请配置 HTTPS 反向代理，设置 `COOKIE_SECURE=true`、`PUBLIC_ORIGIN=https://你的域名`，并将域名加入 `ALLOWED_HOSTS`。

## HTTP 与 MCP

`GET /info` 返回已采集的用量数据；`/mcp` 提供 MCP 工具。两者默认免密，可在管理后台的“访问权限”中申请 Token 并启用密钥访问：

```sh
curl -H 'apikey: YOUR_API_KEY' http://127.0.0.1:8000/info
```

MCP 客户端可在后台“MCP 接入”复制配置示例。用量查询读取已有缓存；联网搜索需在后台为支持的账号启用，且可能消耗渠道额度。接口字段、MCP 工具和参数详见[额度接口使用说明](docs/quota-api.md)。

## 本地开发

使用 Node.js 26.13.0，在项目根目录运行：

```sh
npm ci
npm run check
npm start -- --host 127.0.0.1 --port 8000
```

`npm run check` 包含类型检查、格式检查、测试和生产构建。更多开发命令见[开发说明](docs/development.md)。

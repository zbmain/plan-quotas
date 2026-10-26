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

本地运行可通过 `DATA_DIR` 和 `STATIC_DIR` 指定数据及前端目录；`.env.example` 中的相对路径适用于从项目根目录启动。Compose 固定使用容器内 `/app/data` 和 `/app/frontend/dist`，并将数据挂载到 `plan_quotas_data` 命名卷。健康检查使用 `/healthz`，该端点不得返回凭据或内部文件路径。

数据目录与前端静态目录必须完全分离，不能相同或互相包含；应用会解析符号链接并拒绝不安全的目录配置，防止主密钥和加密凭据被静态服务公开。

## MCP 集成

MCP 服务位于 `/mcp`，使用 Streamable HTTP 和独立 Bearer Token。远程访问应通过 HTTPS 反向代理。令牌只在管理后台创建时明文展示，服务端只保留验证所需的摘要；查询工具只能读取缓存和历史。

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

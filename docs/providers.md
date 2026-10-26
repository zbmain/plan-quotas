# 渠道与凭据说明

每个账号应使用独立别名和凭据。添加前在对应服务确认当前套餐及账户地区。凭据在本机管理后台录入并保存在 Docker 数据卷中；不要把凭据发给他人或写入 issue、日志和仓库。

部分渠道没有稳定公开的用量 API，当前适配可能使用控制台或客户端所调用的接口。供应商可随时调整协议、字段和认证要求。表中标注的方式以版本实现为准；真实账号验证状态应在渠道完成联调后更新。

| 渠道 | 计划支持的凭据 | 预期指标 | 样本解析测试 | 真实账号验证 |
|---|---|---|---|---|
| MiniMax | Coding Plan API Key；可选控制台 Cookie | 套餐窗口额度、剩余比例、重置时间 | 通过 | API Key 查询已验证；Cookie 尚未验证 |
| 智谱 GLM | Coding Plan API Key | 套餐额度、周期及接口提供的专项额度 | 通过 | 尚未实测 |
| Kimi | API Key 或控制台 Cookie／JWT | 订阅额度、使用窗口、重置时间 | 通过 | 尚未实测 |
| DeepSeek | API Key | 账户余额、赠送余额、充值余额及币种 | 通过 | 尚未实测 |
| 火山引擎 | Access Key ID 与 Secret Access Key | Coding Plan 用量、额度及周期 | 通过 | 尚未实测 |
| 阿里云百炼 | 控制台 Cookie／会话凭据 | Coding Plan 用量、额度及周期 | 通过 | 尚未实测 |
| Codex | 用户导入的 OAuth 凭据 | 订阅窗口剩余额度和重置时间 | 通过 | 尚未实测 |
| Claude | OAuth 凭据或会话 Cookie | 会话、周额度及接口提供的专项窗口 | 通过 | 尚未实测 |
| Cursor | 控制台 Cookie／会话凭据 | 套餐消费、额外消费、账单周期 | 通过 | 尚未实测 |
| Google Antigravity | 用户导入的 OAuth 凭据 | 按模型的剩余额度及重置时间 | 通过 | 尚未实测 |

样本解析测试使用测试夹具，不等同于真实供应商账号验证。当前 10 个渠道的样本解析用例均通过；只有 MiniMax API Key 的实际用量查询通过真实接口验证。

## 获取方式提示

- **API Key：**登录服务商官方控制台，在 API Key／密钥管理页面创建；只授予查询用量所需的最低权限。DeepSeek 官方余额接口说明见[余额查询文档](https://api-docs.deepseek.com/api/get-user-balance/)。
- **火山引擎 AK/SK：**在火山引擎控制台的访问控制或密钥管理页面创建，并遵循服务商提供的最小权限策略。不要使用具有无关资源管理权限的主账号凭据。
- **Cookie／会话：**从本人已登录的官方控制台会话按管理页面提示复制。Cookie 等同临时密码，避免截图、分享或长期放在浏览器同步剪贴板中；失效后重新登录并更新。
- **OAuth 凭据：**仅导入自己账号、由受信任客户端或官方授权流程取得的凭据文件／字段。首版不提供网页登录授权流程。具备刷新令牌时适配器才可能自动续期；导入内容缺少刷新信息时，需要重新授权后更新。

管理页面应逐渠道显示当前版本要求的字段、获取说明和是否支持连接测试。不要把浏览器 Cookie 或 OAuth 文件上传到第三方“转换”网站。

## 指标口径

DeepSeek 当前按账户余额展示，不推断 Coding Plan 周期额度。余额注明币种；不同币种不合计。套餐额度按渠道返回的各个窗口分别展示，未知字段显示“暂无数据”。某些渠道只返回剩余量而不返回总量时，不应反推或虚构已用量。

历史趋势来自轮询时的观测快照，可能受渠道刷新延迟、窗口重置和采集间隔影响，不是精确调用日志或账单凭证。

## 参考实现与文档

- [AIMeter 渠道文档](https://github.com/bugwz/AIMeter/blob/main/docs/providers/README.md)
- [CodexBar 支持渠道说明](https://github.com/steipete/CodexBar/blob/main/docs/providers.md)
- [coding-plan-dashboard](https://github.com/margrop/coding-plan-dashboard)
- [codingplan-monitor](https://github.com/Spanky96/codingplan-monitor)

以上链接用于了解公开的功能和渠道现状，不保证其接口或说明适用于本项目当前版本。遵守各项目许可证；本项目不复制其大段代码或文档。

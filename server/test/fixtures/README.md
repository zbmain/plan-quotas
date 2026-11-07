# 兼容性基线

这些文件来自迁移前测试中的合成响应，不含实际部署账号的认证资料。标有 key、cookie、token 等字段的值全部是测试占位值，不是用户凭据。

- `adapters.json`：167 组渠道请求与响应，保留固定时钟、请求头、请求体、返回值、续期值及错误分类。
- `opendesign-usage.json`：62 组 OpenDesign 纯解析场景，覆盖 Credits 精度和异常字段。
- `quotas.json`：18 组外部 V2 JSON 投影；按当前协议在最外层提供 `accountCount/healthy/low/errors`，不再嵌套 `summary` 或返回额度合计，账号额度基线不变。
- `views.json`：8 组页面内部额度投影与汇总。
- `crypto.json`：确定性、仅用于测试的 AES-GCM 主密钥、nonce、明文和 PBKDF2 摘要，验证文件格式兼容。

测试完全使用 TypeScript 和静态 JSON，不需要旧服务或其他语言解释器。更新基线时应先确认上游行为和公开协议，不能仅为了让测试通过而重录输出。不得将真实 Cookie、API Key、OAuth 凭据或运行数据放入此目录。

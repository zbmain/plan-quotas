"""Fixed provider catalog and credential form schemas."""

from plan_quotas.adapters.base import AdapterError


def field(key: str, label: str, required: bool = True, secret: bool = True) -> dict:
    """Describe one credential input without exposing configured values."""
    return {"key": key, "label": label, "required": required, "secret": secret}


def oauth_fields() -> list[dict]:
    """Offer optional refresh metadata for an imported OAuth credential bundle."""
    return [
        field("access_token", "Access Token"),
        field("refresh_token", "Refresh Token", False),
        field("expires_at", "过期时间（ISO 或秒时间戳）", False, False),
        field("client_id", "OAuth Client ID（续期时可能需要）", False),
        field("client_secret", "OAuth Client Secret（续期时可能需要）", False),
    ]


def provider(id: str, name: str, fields: dict, help: str, docs_url: str) -> dict:
    """Build a public provider description using only static metadata."""
    return {
        "id": id,
        "name": name,
        "auth_types": list(fields),
        "fields": fields,
        "help": help,
        "docs_url": docs_url,
    }


PROVIDERS = [
    provider(
        "minimax",
        "MiniMax",
        {
            "api_key": [field("api_key", "Coding Plan API Key")],
            "cookie": [field("cookie", "控制台 Cookie")],
        },
        "优先使用中国区 Coding Plan API Key 查询额度；"
        "支持录入控制台 Cookie，但尚未完成真实接口验证。",
        "https://platform.minimaxi.com/user-center/payment/coding-plan",
    ),
    provider(
        "glm",
        "智谱 GLM",
        {"api_key": [field("api_key", "Coding Plan API Key")]},
        "使用中国区个人 Coding Plan API Key。",
        "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    ),
    provider(
        "kimi",
        "Kimi",
        {
            "api_key": [field("api_key", "Coding API Key")],
            "cookie": [field("cookie", "Kimi Cookie")],
            "jwt": [field("jwt", "Kimi 登录 JWT")],
        },
        "Coding API Key 与网站 JWT 使用不同接口；请按持有的凭据选择。",
        "https://www.kimi.com/code/console",
    ),
    provider(
        "deepseek",
        "DeepSeek",
        {"api_key": [field("api_key", "API Key")]},
        "查询 API 账户余额，不代表订阅套餐额度。",
        "https://platform.deepseek.com/api_keys",
    ),
    provider(
        "volcengine",
        "火山引擎",
        {"aksk": [field("access_key", "Access Key ID"), field("secret_key", "Secret Access Key")]},
        "使用具有 Coding Plan 用量查询权限的访问密钥。",
        "https://console.volcengine.com/iam/keymanage/",
    ),
    provider(
        "aliyun",
        "阿里云百炼",
        {"cookie": [field("cookie", "百炼控制台 Cookie"), field("sec_token", "sec_token", False)]},
        "使用百炼中国区控制台会话；会话失效后需重新导入。",
        "https://bailian.console.aliyun.com/",
    ),
    provider(
        "codex",
        "Codex",
        {"oauth": oauth_fields() + [field("account_id", "ChatGPT Account ID（可选）", False)]},
        "导入 Codex OAuth access_token，可附带 refresh_token；不会读取本机客户端文件。",
        "https://chatgpt.com/codex/settings/usage",
    ),
    provider(
        "claude",
        "Claude",
        {
            "oauth": oauth_fields(),
            "cookie": [
                field("cookie", "Claude Cookie / sessionKey"),
                field("organization_id", "Organization ID（可选）", False),
            ],
        },
        "导入 Claude OAuth 或登录会话，按实际权限返回个人套餐窗口。",
        "https://claude.ai/settings/usage",
    ),
    provider(
        "cursor",
        "Cursor",
        {"cookie": [field("cookie", "Cursor Cookie / WorkosCursorSessionToken")]},
        "使用 Cursor 网站登录会话查询套餐及额外消费。",
        "https://cursor.com/dashboard",
    ),
    provider(
        "antigravity",
        "Antigravity",
        {"oauth": oauth_fields() + [field("project_id", "Project ID（可选）", False)]},
        "导入 Google OAuth；续期需要对应 client_id/client_secret。请先在官方客户端完成账号开通。",
        "https://antigravity.google/",
    ),
]
CATALOG = {item["id"]: item for item in PROVIDERS}

# Authentication pairs verified end to end against a real provider account.
VERIFIED_AUTH_METHODS = {("minimax", "api_key"), ("kimi", "api_key")}


def validate_credentials(provider_id: str, auth_type: str, credentials: dict[str, str]) -> None:
    """Reject unsupported auth types, missing inputs and arbitrary endpoint fields."""
    item = CATALOG.get(provider_id)
    if not item or auth_type not in item["fields"]:
        raise AdapterError("invalid_credentials")
    fields = item["fields"][auth_type]
    allowed = {entry["key"] for entry in fields}
    if set(credentials) - allowed:
        raise AdapterError("invalid_credentials")
    for entry in fields:
        value = credentials.get(entry["key"], "")
        if entry["required"] and not value.strip():
            raise AdapterError("invalid_credentials")
        if len(value) > 32768 or "\r" in value or "\n" in value:
            raise AdapterError("invalid_credentials")

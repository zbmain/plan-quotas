"""Build the fixed registry of supported provider adapters."""


def build_adapters() -> dict:
    """Instantiate stateless adapters; credentials remain account-scoped."""
    from plan_quotas.adapters.china import DeepSeekAdapter, GLMAdapter, MiniMaxAdapter
    from plan_quotas.adapters.china_extra import AliyunAdapter, KimiAdapter, VolcengineAdapter
    from plan_quotas.adapters.global_providers import (
        AntigravityAdapter,
        ClaudeAdapter,
        CodexAdapter,
        CursorAdapter,
    )

    return {
        "minimax": MiniMaxAdapter(),
        "glm": GLMAdapter(),
        "kimi": KimiAdapter(),
        "deepseek": DeepSeekAdapter(),
        "volcengine": VolcengineAdapter(),
        "aliyun": AliyunAdapter(),
        "codex": CodexAdapter(),
        "claude": ClaudeAdapter(),
        "cursor": CursorAdapter(),
        "antigravity": AntigravityAdapter(),
    }

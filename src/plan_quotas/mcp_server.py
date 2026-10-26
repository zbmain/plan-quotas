"""Read-only MCP tools backed by the same cached data as the dashboard."""

from typing import Literal
from uuid import UUID

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings


def build_mcp(get_service) -> FastMCP:
    """Build a stateless server protected by the enclosing app's Host/Origin/Bearer checks."""
    server = FastMCP(
        "plan-quotas",
        stateless_http=True,
        json_response=True,
        streamable_http_path="/mcp",
        max_request_body_size=131072,
        # The enclosing application checks the actual deployment host and origin once.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @server.tool(
        annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
    )
    def list_accounts(provider: str | None = None, status: str | None = None) -> list[dict]:
        """列出已配置账号的公开别名、渠道、状态和数据更新时间，不返回凭据。"""
        return get_service().list_accounts(provider, status)

    @server.tool(
        annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
    )
    def get_usage(account_ids: list[str] | None = None, provider: str | None = None) -> list[dict]:
        """读取账号当前额度或余额缓存；不同指标、周期与币种不可相加，不触发上游刷新。"""
        if account_ids is not None:
            if len(account_ids) > 100:
                raise ValueError("一次最多查询 100 个账号")
            for value in account_ids:
                UUID(value)
        return get_service().get_usage(account_ids, provider)

    @server.tool(
        annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
    )
    def get_summary() -> dict:
        """按渠道汇总账号正常、异常和额度紧张数量，不合并不同渠道的消费。"""
        return get_service().summary()

    @server.tool(
        annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
    )
    def get_history(account_id: str, range: Literal["24h", "7d", "30d"] = "24h") -> dict:
        """查询一个账号的采样历史，含缺测和重置标记；不是精确消费账单。"""
        UUID(account_id)
        if not get_service().get_usage([account_id]):
            raise ValueError("账号不存在")
        return get_service().history(account_id, range)

    return server

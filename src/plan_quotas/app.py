"""HTTP application with isolated public, administrator and MCP surfaces."""

import asyncio
import contextlib
import hmac
import json
import secrets
import time
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from plan_quotas.adapters.base import AdapterError
from plan_quotas.catalog import PROVIDERS, VERIFIED_AUTH_METHODS, validate_credentials
from plan_quotas.mcp_server import build_mcp
from plan_quotas.models import Account, AuthType, ProviderId
from plan_quotas.registry import build_adapters
from plan_quotas.security import (
    COOKIE_NAME,
    SESSION_TTL,
    AdminAuth,
    InfoPasswordAuth,
    InfoQueryRedactor,
    token_hash,
)
from plan_quotas.service import QuotaService
from plan_quotas.settings import Settings
from plan_quotas.storage import Store, StoreError


class LoginInput(BaseModel):
    """Accept a bounded administrator password."""

    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=4096)


class AccountInput(BaseModel):
    """Accept only supported account metadata and bounded credential maps."""

    model_config = ConfigDict(extra="forbid")
    provider: ProviderId
    alias: str = Field(min_length=1, max_length=80)
    auth_type: AuthType
    credentials: dict[str, str] = Field(max_length=16)
    enabled: bool = True
    order: int = Field(default=0, ge=-100000, le=100000)


class AccountPatch(BaseModel):
    """Omitted credentials preserve the existing encrypted values."""

    model_config = ConfigDict(extra="forbid")
    alias: str | None = Field(default=None, min_length=1, max_length=80)
    auth_type: AuthType | None = None
    credentials: dict[str, str] | None = Field(default=None, max_length=16)
    enabled: bool | None = None
    order: int | None = Field(default=None, ge=-100000, le=100000)


class TestInput(BaseModel):
    """Permit connection tests with new credentials or a configured account."""

    model_config = ConfigDict(extra="forbid")
    provider: ProviderId
    auth_type: AuthType
    credentials: dict[str, str] = Field(default_factory=dict, max_length=16)
    account_id: UUID | None = None


class SettingsInput(BaseModel):
    """Constrain the shared polling interval."""

    model_config = ConfigDict(extra="forbid")
    interval_minutes: int = Field(ge=1, le=60)


class InfoSettingsInput(BaseModel):
    """Configure the separate read-only /info password without accepting its hash."""

    model_config = ConfigDict(extra="forbid")
    require_password: bool
    password: str | None = Field(default=None, max_length=4096)


def create_app(
    settings: Settings | None = None,
    *,
    adapters: dict | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    poll: bool = True,
) -> FastAPI:
    """Construct an application with injectable transport and collectors for isolated tests."""
    settings = settings or Settings()
    private_root = settings.data_dir.resolve()
    public_root = settings.static_dir.resolve()
    if private_root.is_relative_to(public_root) or public_root.is_relative_to(private_root):
        raise StoreError("DATA_DIR and STATIC_DIR must be separate, non-overlapping directories")
    store = Store(settings.data_dir)
    auth = AdminAuth(settings.admin_password)
    info_auth = InfoPasswordAuth()
    active_adapters = dict(adapters) if adapters is not None else {}
    pending_credentials: dict[str, tuple[float, dict[str, str]]] = {}

    def credential_key(request: Request, provider: str, auth_type: str, credentials: dict) -> str:
        """Bind a short-lived test result to the administrator session and original input."""
        return token_hash(
            json.dumps(
                [request.cookies.get(COOKIE_NAME), provider, auth_type, credentials], sort_keys=True
            )
        )

    def resolved_credentials(
        request: Request, provider: str, auth_type: str, credentials: dict
    ) -> dict:
        """Reuse a rotated test credential during save without sending it to the browser."""
        now = time.monotonic()
        for key, (expires, _) in list(pending_credentials.items()):
            if expires < now:
                del pending_credentials[key]
        item = pending_credentials.get(credential_key(request, provider, auth_type, credentials))
        return dict(item[1]) if item else credentials

    def remember_rotation(
        request: Request, provider: str, auth_type: str, original: dict, rotated: dict | None
    ) -> None:
        """Keep at most 100 pending credential rotations for a five-minute save window."""
        if rotated:
            if len(pending_credentials) >= 100:
                pending_credentials.pop(next(iter(pending_credentials)))
            pending_credentials[credential_key(request, provider, auth_type, original)] = (
                time.monotonic() + 300,
                rotated,
            )

    mcp = build_mcp(lambda: application.state.service)
    mcp_http = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        """Own the data lock, shared HTTP client, collector and MCP task manager."""
        store.open()
        stop = asyncio.Event()
        try:
            if adapters is None:
                active_adapters.update(build_adapters())
            async with httpx.AsyncClient(
                transport=transport, timeout=15, limits=httpx.Limits(max_connections=12)
            ) as client:
                application.state.service = QuotaService(store, client, active_adapters)
                application.state.store = store
                application.state.client = client
                async with mcp.session_manager.run():
                    task = (
                        asyncio.create_task(application.state.service.run(stop)) if poll else None
                    )
                    try:
                        yield
                    finally:
                        stop.set()
                        if task:
                            task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await task
        finally:
            auth.sessions.clear()
            store.close()

    application = FastAPI(
        title="plan-quotas",
        version="0.0.1",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @application.middleware("http")
    async def protect_boundaries(request: Request, call_next):
        """Enforce origin, request size and MCP credentials before dispatching handlers."""
        path = request.url.path
        origin = request.headers.get("origin")
        expected = settings.public_origin.rstrip("/") or str(request.base_url).rstrip("/")
        if origin and origin != expected:
            return JSONResponse({"detail": "请求来源不受信任"}, status_code=403)
        if path.startswith("/api/admin/") and path != "/api/admin/login":
            try:
                auth.require(request, write=request.method not in {"GET", "HEAD", "OPTIONS"})
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "请求来源不受信任"}, status_code=403)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 131072:
                    return JSONResponse({"detail": "请求内容过大"}, status_code=413)
            request._body = bytes(body)
        if path == "/mcp" or path.startswith("/mcp/"):
            header = request.headers.get("authorization", "")
            configured = store.config.mcp_token_hash
            if (
                not configured
                or not header.startswith("Bearer ")
                or not hmac.compare_digest(token_hash(header[7:]), configured)
            ):
                return JSONResponse(
                    {"detail": "MCP 需要有效访问令牌"},
                    status_code=401,
                    headers={"WWW-Authenticate": "Bearer"},
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'"
        )
        if path.startswith(("/api/", "/mcp")):
            response.headers["Cache-Control"] = "no-store"
        return response

    application.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.hosts)

    @application.exception_handler(RequestValidationError)
    async def safe_validation(request: Request, exc: RequestValidationError):
        """Suppress Pydantic's input echo, which could otherwise include credentials."""
        return JSONResponse({"detail": "请求参数无效，请检查字段和输入格式"}, status_code=422)

    @application.exception_handler(AdapterError)
    async def safe_adapter_error(request: Request, exc: AdapterError):
        """Expose only a fixed error code instead of upstream error bodies."""
        allowed = {
            "auth_required",
            "invalid_credentials",
            "rate_limited",
            "network_error",
            "upstream_error",
            "invalid_response",
        }
        code = exc.code if exc.code in allowed else "invalid_response"
        return JSONResponse(
            {"detail": code}, status_code=400 if code == "invalid_credentials" else 502
        )

    @application.exception_handler(StoreError)
    async def safe_storage_error(request: Request, exc: StoreError):
        """Report an actionable storage failure without paths or private data."""
        return JSONResponse({"detail": "存储异常，请检查数据目录权限与备份"}, status_code=503)

    def service() -> QuotaService:
        """Get the lifespan-owned shared collection service."""
        return application.state.service

    def find_account(account_id: str) -> Account:
        """Look up an opaque account ID without allowing filesystem path inputs."""
        account = next((item for item in store.config.accounts if item.id == account_id), None)
        if not account:
            raise HTTPException(404, "账号不存在")
        return account

    @application.get("/healthz")
    async def health():
        """Return only process health, never configuration or credentials."""
        return {"status": "ok"}

    @application.get("/api/public/providers")
    async def providers():
        """Expose static provider descriptions and supported authentication fields."""
        return PROVIDERS

    @application.get("/api/public/dashboard")
    async def dashboard():
        """Read cached public usage without triggering provider calls."""
        return service().dashboard()

    @application.get("/info")
    @application.get("/info/")
    async def info(request: Request):
        """Return cached, secret-free account usage as JSON after optional query-password auth."""
        if store.config.info_require_password:
            password = request.scope.get("state", {}).get("info_query_password")
            invalid_query = request.scope.get("state", {}).get("info_query_invalid", False)
            peer = request.client.host if request.client else "unknown"
            if invalid_query or not await info_auth.verify(
                store.config.info_password_hash, password, peer
            ):
                raise HTTPException(401, "无效或缺少查询密码")
        return service().dashboard()

    @application.get("/api/public/accounts/{account_id}/history")
    async def history(account_id: UUID, range: Literal["24h", "7d", "30d"] = "24h"):
        """Read bounded, bucketed public history for an existing account."""
        find_account(str(account_id))
        return service().history(str(account_id), range)

    @application.post("/api/admin/login")
    async def login(payload: LoginInput, request: Request, response: Response):
        """Authenticate with the configured password and set an opaque session cookie."""
        token, session = auth.login(
            payload.password, request.client.host if request.client else "unknown"
        )
        response.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="strict",
            max_age=SESSION_TTL,
            path="/api/admin",
        )
        return {"csrf_token": session.csrf, "default_password": settings.admin_password == "admin"}

    @application.get("/api/admin/session")
    async def session(request: Request):
        """Restore the CSRF token only for the already-authenticated admin session."""
        current = auth.require(request)
        return {"csrf_token": current.csrf, "default_password": settings.admin_password == "admin"}

    @application.post("/api/admin/logout")
    async def logout(request: Request, response: Response):
        """Revoke the admin session and expire its browser cookie."""
        auth.require(request, write=True)
        auth.logout(request)
        response.delete_cookie(COOKIE_NAME, path="/api/admin")
        return {"ok": True}

    @application.get("/api/admin/accounts")
    async def admin_accounts(request: Request):
        """Expose editable metadata and presence flags, never stored credential values."""
        auth.require(request)
        return [
            {
                **account.model_dump(mode="json"),
                "credential_configured": bool(store.get_credentials(account.id)),
                "credential_keys": sorted(store.get_credentials(account.id)),
                "verification": (
                    "verified"
                    if (account.provider, account.auth_type) in VERIFIED_AUTH_METHODS
                    else "not_tested"
                ),
            }
            for account in sorted(store.config.accounts, key=lambda item: item.order)
        ]

    @application.post("/api/admin/accounts", status_code=201)
    async def add_account(payload: AccountInput, request: Request):
        """Save a new profile with encrypted credentials and schedule initial collection."""
        auth.require(request, write=True)
        validate_credentials(payload.provider, payload.auth_type, payload.credentials)
        if not payload.alias.strip():
            raise HTTPException(422, "请输入账号别名")
        if len(store.config.accounts) >= 100:
            raise HTTPException(400, "当前实例最多支持 100 个账号")
        account = Account(id=str(uuid4()), **payload.model_dump(exclude={"credentials"}))
        async with service().account_lock(account.id):
            store.set_credentials(
                account.id,
                resolved_credentials(
                    request, payload.provider, payload.auth_type, payload.credentials
                ),
            )
            store.save_config(
                store.config.model_copy(update={"accounts": [*store.config.accounts, account]})
            )
        return account

    @application.patch("/api/admin/accounts/{account_id}")
    async def edit_account(account_id: UUID, payload: AccountPatch, request: Request):
        """Update metadata or replace credentials under the collection lock."""
        auth.require(request, write=True)
        id = str(account_id)
        async with service().account_lock(id):
            current = find_account(id)
            changes = payload.model_dump(exclude_unset=True, exclude={"credentials"})
            if any(value is None for value in changes.values()):
                raise HTTPException(422, "字段不能为 null")
            if "alias" in changes and not changes["alias"].strip():
                raise HTTPException(422, "请输入账号别名")
            updated = Account.model_validate({**current.model_dump(), **changes})
            credentials = (
                payload.credentials
                if payload.credentials is not None
                else store.get_credentials(id)
            )
            validate_credentials(updated.provider, updated.auth_type, credentials)
            if payload.credentials is not None:
                store.set_credentials(
                    id,
                    resolved_credentials(request, updated.provider, updated.auth_type, credentials),
                )
                service().reset_account(id)
            store.save_config(
                store.config.model_copy(
                    update={
                        "accounts": [
                            updated if item.id == id else item for item in store.config.accounts
                        ]
                    }
                )
            )
        return updated

    @application.delete("/api/admin/accounts/{account_id}")
    async def delete_account(account_id: UUID, request: Request):
        """Remove an account and all associated private and historical data."""
        auth.require(request, write=True)
        id = str(account_id)
        async with service().account_lock(id):
            find_account(id)
            store.save_config(
                store.config.model_copy(
                    update={"accounts": [item for item in store.config.accounts if item.id != id]}
                )
            )
            store.delete_account_data(id)
        return {"ok": True}

    @application.post("/api/admin/test")
    async def test_connection(payload: TestInput, request: Request):
        """Test fixed provider endpoints and persist rotated credentials for existing profiles."""
        auth.require(request, write=True)
        credentials = payload.credentials
        id = str(payload.account_id) if payload.account_id else None
        lock = service().account_lock(id) if id else asyncio.Lock()
        async with lock:
            if id:
                account = find_account(id)
                if account.provider != payload.provider:
                    raise HTTPException(400, "渠道与账号不匹配")
                if not credentials:
                    credentials = store.get_credentials(id)
            validate_credentials(payload.provider, payload.auth_type, credentials)
            original = credentials
            credentials = resolved_credentials(
                request, payload.provider, payload.auth_type, original
            )
            async with service().collection_slot():
                try:
                    data, rotated = await active_adapters[payload.provider].fetch(
                        credentials, payload.auth_type, application.state.client
                    )
                except AdapterError as exc:
                    rotated = getattr(exc, "rotated_credentials", None)
                    remember_rotation(
                        request, payload.provider, payload.auth_type, original, rotated
                    )
                    if rotated and id and store.get_credentials(id) == original:
                        store.set_credentials(id, rotated)
                    raise
                except Exception:
                    raise AdapterError("invalid_response") from None
            remember_rotation(request, payload.provider, payload.auth_type, original, rotated)
            if rotated and id and store.get_credentials(id) == original:
                store.set_credentials(id, rotated)
            return {
                "ok": True,
                "data": service()._sanitize_result(data, {**credentials, **(rotated or {})}),
            }

    @application.post("/api/admin/accounts/{account_id}/refresh")
    async def refresh(account_id: UUID, request: Request):
        """Request an authenticated, cooldown-limited refresh of one profile."""
        auth.require(request, write=True)
        find_account(str(account_id))
        result = await service().refresh(str(account_id), manual=True)
        return {"ok": result.status == "ok", "status": result.status}

    @application.get("/api/admin/settings")
    async def get_settings(request: Request):
        """Expose editable non-secret settings and MCP token presence."""
        auth.require(request)
        return {
            "interval_minutes": store.config.interval_minutes,
            "mcp_configured": bool(store.config.mcp_token_hash),
        }

    @application.patch("/api/admin/settings")
    async def update_settings(payload: SettingsInput, request: Request):
        """Persist the validated global collection interval."""
        auth.require(request, write=True)
        store.save_config(
            store.config.model_copy(update={"interval_minutes": payload.interval_minutes})
        )
        return await get_settings(request)

    @application.get("/api/admin/info-settings")
    async def get_info_settings(request: Request):
        """Expose only the info access mode and whether an independent password exists."""
        auth.require(request)
        return {
            "require_password": store.config.info_require_password,
            "password_configured": bool(store.config.info_password_hash),
        }

    @application.patch("/api/admin/info-settings")
    async def update_info_settings(payload: InfoSettingsInput, request: Request):
        """Atomically update /info access controls while keeping plaintext out of storage."""
        auth.require(request, write=True)
        if payload.password:
            password_hash = await asyncio.to_thread(info_auth.hash_password, payload.password)
        else:
            password_hash = store.config.info_password_hash
        if payload.require_password and not password_hash:
            raise HTTPException(400, "启用密码访问前，请先设置独立查询密码")
        store.save_config(
            store.config.model_copy(
                update={
                    "info_require_password": payload.require_password,
                    "info_password_hash": password_hash,
                }
            )
        )
        return await get_info_settings(request)

    @application.post("/api/admin/mcp-token")
    async def rotate_mcp_token(request: Request):
        """Generate a random MCP token, store only its hash and disclose it once."""
        auth.require(request, write=True)
        token = "pq_" + secrets.token_urlsafe(32)
        store.save_config(store.config.model_copy(update={"mcp_token_hash": token_hash(token)}))
        return {"token": token}

    @application.delete("/api/admin/mcp-token")
    async def revoke_mcp_token(request: Request):
        """Invalidate the current read-only MCP access token immediately."""
        auth.require(request, write=True)
        store.save_config(store.config.model_copy(update={"mcp_token_hash": None}))
        return {"ok": True}

    @application.get("/")
    @application.get("/admin")
    @application.get("/admin/")
    async def frontend():
        """Serve only the built entry point for explicit browser routes."""
        entry = settings.static_dir / "index.html"
        if not entry.is_file():
            return JSONResponse(
                {"detail": "前端尚未构建，请先执行 just build-frontend"}, status_code=503
            )
        return FileResponse(entry)

    assets = settings.static_dir / "assets"
    if assets.is_dir():
        application.mount(
            "/assets", StaticFiles(directory=assets, follow_symlink=False), name="assets"
        )
    application.add_middleware(InfoQueryRedactor)
    application.mount("/", mcp_http)
    return application


app = create_app()

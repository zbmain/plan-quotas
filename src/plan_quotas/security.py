"""In-memory admin sessions and a separately managed read-only MCP token."""

import asyncio
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from urllib.parse import parse_qsl

from fastapi import HTTPException, Request

COOKIE_NAME = "pq_session"
SESSION_TTL = 8 * 60 * 60


def token_hash(value: str) -> str:
    """Hash a high-entropy service token without storing its plaintext."""
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass
class Session:
    """Keep a CSRF token and expiration bound to an opaque admin session."""

    csrf: str
    expires: float


class AdminAuth:
    """Validate a deployment password and limit failed login attempts by peer address."""

    def __init__(self, password: str):
        """Retain a fixed-size password digest and initialize ephemeral session state."""
        self.password_digest = token_hash(password)
        self.sessions: dict[str, Session] = {}
        self.failures: dict[str, deque[float]] = defaultdict(deque)

    def login(self, password: str, peer: str) -> tuple[str, Session]:
        """Create a session after constant-time comparison and five-attempt throttling."""
        now = time.monotonic()
        for address in list(self.failures):
            while self.failures[address] and self.failures[address][0] < now - 900:
                self.failures[address].popleft()
            if not self.failures[address]:
                del self.failures[address]
        attempts = self.failures[peer]
        if len(attempts) >= 5:
            raise HTTPException(429, "登录尝试过多，请在 15 分钟后重试")
        if not hmac.compare_digest(token_hash(password), self.password_digest):
            attempts.append(now)
            raise HTTPException(401, "管理密码不正确")
        self.failures.pop(peer, None)
        self.sessions = {key: value for key, value in self.sessions.items() if value.expires > now}
        if len(self.sessions) >= 100:
            self.sessions.pop(next(iter(self.sessions)))
        token = secrets.token_urlsafe(32)
        session = Session(secrets.token_urlsafe(32), now + SESSION_TTL)
        self.sessions[token_hash(token)] = session
        return token, session

    def require(self, request: Request, *, write: bool = False) -> Session:
        """Authorize a session and verify its synchronizer token for mutations."""
        token = request.cookies.get(COOKIE_NAME, "")
        session = self.sessions.get(token_hash(token))
        if not session or session.expires <= time.monotonic():
            raise HTTPException(401, "请先登录管理后台")
        if write and not hmac.compare_digest(request.headers.get("x-csrf-token", ""), session.csrf):
            raise HTTPException(403, "请求验证失败，请刷新页面后重试")
        return session

    def logout(self, request: Request) -> None:
        """Revoke the current session immediately."""
        self.sessions.pop(token_hash(request.cookies.get(COOKIE_NAME, "")), None)


class InfoQueryRedactor:
    """Redact /info query strings before routing and logging while keeping its password local."""

    def __init__(self, app):
        """Wrap the ASGI app with query cleanup and non-cacheable response headers."""
        self.app = app

    async def __call__(self, scope, receive, send):
        """Store one bounded password value in request state and redact the raw URL."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        info_path = path == "/info" or path.startswith("/info/")
        if not info_path:
            await self.app(scope, receive, send)
            return

        state = scope.setdefault("state", {})
        query_string = scope.get("query_string", b"")
        parameters = []
        invalid = len(query_string) > 16384
        if not invalid:
            try:
                parameters = parse_qsl(
                    query_string.decode("ascii", "replace"),
                    keep_blank_values=True,
                    max_num_fields=64,
                )
            except ValueError:
                invalid = True
        passwords = [value for key, value in parameters if key == "password"]
        if len(passwords) > 1:
            invalid = True
        password = passwords[0] if len(passwords) == 1 else None
        if password is not None and len(password) > 4096:
            invalid = True
        state["info_query_password"] = None if invalid else password
        state["info_query_invalid"] = invalid
        scope["query_string"] = b""
        if "raw_path" in scope:
            scope["raw_path"] = scope["raw_path"].split(b"?", 1)[0]

        async def send_private(message):
            """Mark every matched and unmatched /info response private and non-referring."""
            if message["type"] == "http.response.start":
                headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() not in {b"cache-control", b"referrer-policy"}
                ]
                headers.extend(
                    [
                        (b"cache-control", b"no-store"),
                        (b"referrer-policy", b"no-referrer"),
                    ]
                )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_private)


class InfoPasswordAuth:
    """Verify the independent /info password and throttle failed lookups by peer."""

    _ITERATIONS = 600_000

    def __init__(self):
        """Initialize an in-memory, per-peer sliding window for failed attempts."""
        self.failures: dict[str, deque[float]] = defaultdict(deque)
        self.lock = asyncio.Lock()

    @classmethod
    def hash_password(cls, password: str) -> str:
        """Encode the info password with a random salt and a slow PBKDF2 digest."""
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, cls._ITERATIONS, dklen=32
        )
        return f"pbkdf2_sha256${cls._ITERATIONS}${salt.hex()}${digest.hex()}"

    @classmethod
    def password_matches(cls, encoded: str | None, password: str | None) -> bool:
        """Check a supplied password against a recognized hash without leaking timing."""
        if not encoded or password is None:
            return False
        try:
            algorithm, rounds_text, salt_text, expected_text = encoded.split("$", 3)
            rounds = int(rounds_text)
            salt = bytes.fromhex(salt_text)
            expected = bytes.fromhex(expected_text)
            if (
                algorithm != "pbkdf2_sha256"
                or rounds != cls._ITERATIONS
                or len(salt) != 16
                or len(expected) != 32
            ):
                return False
        except (ValueError, TypeError):
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds, dklen=32)
        return hmac.compare_digest(digest, expected)

    async def verify(self, password_hash: str | None, password: str | None, peer: str) -> bool:
        """Serialize each KDF check with its rolling limiter and run PBKDF2 off-loop."""
        async with self.lock:
            now = time.monotonic()
            for address in list(self.failures):
                attempts = self.failures[address]
                while attempts and attempts[0] <= now - 900:
                    attempts.popleft()
                if not attempts:
                    del self.failures[address]
            attempts = self.failures.get(peer)
            if attempts and len(attempts) >= 5:
                raise HTTPException(429, "查询密码尝试过多，请 15 分钟后重试")
            matches = await asyncio.to_thread(self.password_matches, password_hash, password)
            if not matches:
                self.failures[peer].append(now)
                return False
            self.failures.pop(peer, None)
            return True

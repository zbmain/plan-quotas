"""In-memory admin sessions and a separately managed read-only MCP token."""

import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

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

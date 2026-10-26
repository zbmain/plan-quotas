"""Deployment configuration, never serialized to public endpoints."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read local environment settings with safe development defaults."""

    admin_password: str = "admin"
    data_dir: Path = Path("data")
    static_dir: Path = Path("frontend/dist")
    cookie_secure: bool = False
    allowed_hosts: str = "localhost,127.0.0.1,[::1]"
    public_origin: str = ""
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def hosts(self) -> list[str]:
        """Split trusted hostnames without treating proxy headers as trusted input."""
        return [value.strip() for value in self.allowed_hosts.split(",") if value.strip()]

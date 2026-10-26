"""Small operational CLI without credential-printing commands."""

import typer
import uvicorn

app = typer.Typer(help="plan-quotas 本地服务管理")


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8000):
    """启动单进程服务；账号和凭据通过 /admin 页面管理。"""
    uvicorn.run("plan_quotas.app:app", host=host, port=port, workers=1)

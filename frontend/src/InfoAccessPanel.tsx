import { useCallback, useEffect, useState } from "react";
import { FileJson, LoaderCircle } from "lucide-react";
import { CopyButton } from "./CopyButton";

type InfoSettings = { require_password: boolean; password_configured: boolean };

/** Configure the read-only JSON endpoint without displaying its saved password. */
export function InfoAccessPanel({
  csrf,
  onNotice,
}: {
  csrf: string;
  onNotice: (message: string) => void;
}) {
  const [saved, setSaved] = useState<InfoSettings | null>(null);
  const [requirePassword, setRequirePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** Read only the access mode and password-presence flag from the administrator API. */
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/info-settings", {
        credentials: "same-origin",
        signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "访问设置读取失败");
      setSaved(body);
      setRequirePassword(body.require_password);
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : "访问设置读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Save the selected mode; an omitted password retains the existing server-side secret. */
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !saved) return;
    if (requirePassword && !saved.password_configured && !password) {
      setError("请先设置查询密码，再启用密码访问");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/info-settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          require_password: requirePassword,
          ...(requirePassword && password ? { password } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "访问设置保存失败");
      setSaved(body);
      setRequirePassword(body.require_password);
      setPassword("");
      onNotice("/info 访问设置已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "访问设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const example = `${location.origin}/info${saved?.require_password ? "?password=YOUR_PASSWORD" : ""}`;
  return (
    <section className="admin-panel settings-panel info-access-panel">
      <div className="panel-title">
        <div>
          <h2>用量 JSON 接口</h2>
          <p>通过 GET /info 读取所有已配置渠道的缓存用量</p>
        </div>
        <FileJson size={18} className="panel-icon" />
      </div>
      {loading ? (
        <p className="info-access-hint">正在读取访问设置…</p>
      ) : saved ? (
        <form onSubmit={(event) => void save(event)}>
          <div className="setting-row">
            <div>
              <strong>访问方式</strong>
              <span>仅控制 /info；公开首页仍可直接查看</span>
            </div>
            <div className="setting-control">
              <select
                aria-label="/info 访问方式"
                value={requirePassword ? "password" : "public"}
                onChange={(event) =>
                  setRequirePassword(event.target.value === "password")
                }
                disabled={saving}
              >
                <option value="public">允许免密码访问</option>
                <option value="password">需要查询密码</option>
              </select>
              <button
                type="submit"
                className="button secondary small"
                disabled={saving}
              >
                {saving && <LoaderCircle size={13} className="spin" />}
                {saving ? "保存中…" : "保存访问设置"}
              </button>
            </div>
          </div>
          {requirePassword && (
            <label className="field-label info-password-field">
              <span>
                查询密码 {saved.password_configured && <small>已配置</small>}
              </span>
              <input
                type="password"
                aria-label="/info 查询密码"
                autoComplete="new-password"
                value={password}
                maxLength={4096}
                disabled={saving}
                placeholder={
                  saved.password_configured
                    ? "留空保留原密码；填写新密码即可更换"
                    : "设置独立查询密码"
                }
                onChange={(event) => setPassword(event.target.value)}
              />
              <small>与管理员密码、MCP 令牌相互独立，保存后不回显。</small>
            </label>
          )}
        </form>
      ) : (
        <button className="button secondary small" onClick={() => void load()}>
          重新读取设置
        </button>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <>
          <div className="mcp-endpoint info-endpoint">
            <span>请求示例</span>
            <code>{example}</code>
            <CopyButton
              text={example}
              label="复制 /info 请求示例"
              successMessage="请求示例已复制"
              failureMessage="复制失败，请手动选择并复制示例地址"
              onNotice={onNotice}
            />
          </div>
          <p className="info-access-hint">
            {saved.require_password
              ? "当前需要密码。将示例中的 YOUR_PASSWORD 替换为 URL 编码后的查询密码。"
              : "当前允许免密码访问。返回账号别名、用量指标、状态和更新时间，不包含渠道凭据。"}
          </p>
        </>
      )}
    </section>
  );
}

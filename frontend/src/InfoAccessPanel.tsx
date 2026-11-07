import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import type { ApiAccessSettings } from "./types";
import { copyText } from "./clipboard";
import { IntegrationPanels } from "./IntegrationPanels";

/** Manage revealable keys in transient memory and share only the saved access mode with examples. */
export function InfoAccessPanel({
  csrf,
  onNotice,
}: {
  csrf: string;
  onNotice: (message: string) => void;
}) {
  const [saved, setSaved] = useState<ApiAccessSettings | null>(null);
  const [required, setRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const epoch = useRef(0);
  const active = useRef(false);

  /** Send administrator requests without retaining credentials in URLs or persistent browser state. */
  const request = useCallback(
    async <T,>(path: string, method = "GET"): Promise<T> => {
      const response = await fetch(`/api/admin/${path}`, {
        credentials: "same-origin",
        method,
        cache: "no-store",
        headers: {
          "X-CSRF-Token": csrf,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.detail || "访问设置操作失败，请重试");
      return body as T;
    },
    [csrf],
  );

  /** Load metadata while leaving previously viewed key values out of all list requests. */
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await request<ApiAccessSettings>("access-settings");
      if (active.current) {
        setSaved(body);
        setRequired(body.require_apikey);
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "访问设置读取失败");
    } finally {
      if (active.current) setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    active.current = true;
    /** Conceal values on page departure or backgrounding, including back-forward cache restores. */
    const conceal = () => {
      epoch.current++;
      setRevealed({});
    };
    const onVisibility = () => {
      if (document.hidden) conceal();
    };
    void load();
    window.addEventListener("pagehide", conceal);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active.current = false;
      epoch.current++;
      window.removeEventListener("pagehide", conceal);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  /** Persist the explicit mode selection; generating a key never silently changes this mode. */
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !saved) return;
    setBusy("save");
    setError("");
    try {
      const response = await fetch("/api/admin/access-settings", {
        credentials: "same-origin",
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ require_apikey: required }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "访问方式保存失败");
      if (active.current) {
        setSaved(body);
        onNotice("API 与 MCP 访问方式已保存");
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "访问方式保存失败");
    } finally {
      if (active.current) setBusy("");
    }
  };

  /** Generate server-side and reload metadata without requesting or revealing the new value. */
  const create = async () => {
    if (busy) return;
    setBusy("create");
    setError("");
    try {
      await request("access-tokens", "POST");
      const body = await request<ApiAccessSettings>("access-settings");
      if (active.current) {
        setSaved(body);
        onNotice("Token 已申请，点击眼睛查看或复制使用");
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Token 申请失败");
    } finally {
      if (active.current) setBusy("");
    }
  };

  /** Reveal or copy on demand; ignore late responses after concealment or leaving this page. */
  const useToken = async (id: string, action: "view" | "copy" | "revoke") => {
    if (busy || pending[id]) return;
    if (action === "view" && revealed[id]) {
      setRevealed((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
      return;
    }
    if (
      action === "revoke" &&
      !window.confirm(
        "撤销此 Token？使用它的 API 和 MCP 客户端将立即失去访问权限。",
      )
    )
      return;
    const currentEpoch = epoch.current;
    setPending((old) => ({ ...old, [id]: true }));
    setError("");
    try {
      if (action === "revoke") {
        await request(`access-tokens/${id}`, "DELETE");
        if (active.current) {
          setSaved(
            (old) =>
              old && {
                ...old,
                tokens: old.tokens.filter((row) => row.id !== id),
              },
          );
          setRevealed((old) => {
            const next = { ...old };
            delete next[id];
            return next;
          });
          onNotice("Token 已撤销");
        }
      } else {
        const body = await request<{ apikey: string }>(
          `access-tokens/${id}/reveal`,
          "POST",
        );
        if (!active.current || epoch.current !== currentEpoch) return;
        if (action === "view")
          setRevealed((old) => ({ ...old, [id]: body.apikey }));
        else {
          await copyText(body.apikey);
          onNotice("Token 已复制");
        }
      }
    } catch (cause) {
      if (active.current)
        setError(
          action === "copy"
            ? "Token 复制失败，请重试或点击眼睛后手动复制"
            : cause instanceof Error
              ? cause.message
              : "Token 操作失败",
        );
    } finally {
      if (active.current) setPending((old) => ({ ...old, [id]: false }));
    }
  };

  const rowBusy = Object.values(pending).some(Boolean);
  return (
    <>
      <section
        className="admin-panel settings-panel info-access-panel"
        aria-labelledby="access-heading"
      >
        <div className="panel-title">
          <div>
            <h2 id="access-heading">访问权限</h2>
            <p>管理 API 与 MCP 的访问方式，公开仪表盘仍可直接查看</p>
          </div>
          <KeyRound size={18} className="panel-icon" />
        </div>
        {loading ? (
          <p className="info-access-hint" role="status">
            正在读取访问设置…
          </p>
        ) : saved ? (
          <>
            <form onSubmit={(event) => void save(event)}>
              <div className="setting-row">
                <div>
                  <strong>访问方式</strong>
                  <span>一个有效 Token 即可访问 /info 与 /mcp</span>
                </div>
                <div className="setting-control">
                  <select
                    aria-label="接口访问方式"
                    value={required ? "apikey" : "public"}
                    onChange={(event) =>
                      setRequired(event.target.value === "apikey")
                    }
                    disabled={Boolean(busy) || rowBusy}
                  >
                    <option value="public">免密访问</option>
                    <option value="apikey">需要密钥</option>
                  </select>
                  <button
                    type="submit"
                    className="button secondary btn btn--secondary small"
                    disabled={
                      Boolean(busy) ||
                      rowBusy ||
                      required === saved.require_apikey
                    }
                  >
                    {busy === "save" && (
                      <LoaderCircle size={13} className="spin" />
                    )}
                    保存访问方式
                  </button>
                </div>
              </div>
            </form>
            <div className="access-token-heading">
              <div>
                <strong>访问 Token</strong>
                <span>
                  已创建 {saved.tokens.length} / {saved.limit}
                </span>
              </div>
              <button
                type="button"
                className="button secondary btn btn--secondary small"
                disabled={
                  Boolean(busy) || rowBusy || saved.tokens.length >= saved.limit
                }
                onClick={() => void create()}
              >
                {busy === "create" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Plus size={14} />
                )}
                申请 Token
              </button>
            </div>
            {saved.tokens.length ? (
              <ul className="access-token-list">
                {saved.tokens.map((token, index) => (
                  <li
                    className="access-token-row"
                    key={token.id}
                    aria-busy={Boolean(pending[token.id])}
                  >
                    <div className="access-token-meta">
                      <strong>Token {index + 1}</strong>
                      <time dateTime={token.created_at}>
                        {new Date(token.created_at).toLocaleString("zh-CN", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </time>
                    </div>
                    <code
                      className={`access-token-value${revealed[token.id] ? " is-visible" : ""}`}
                      aria-label={`Token ${index + 1}${revealed[token.id] ? " 密钥" : " 已隐藏"}`}
                    >
                      {revealed[token.id] || "sk-••••••••••••••••"}
                    </code>
                    <div className="row-actions access-token-actions">
                      <button
                        type="button"
                        aria-label={`${revealed[token.id] ? "隐藏" : "查看"} Token ${index + 1}`}
                        aria-pressed={Boolean(revealed[token.id])}
                        disabled={Boolean(busy) || Boolean(pending[token.id])}
                        onClick={() => void useToken(token.id, "view")}
                      >
                        {revealed[token.id] ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`复制 Token ${index + 1}`}
                        disabled={Boolean(busy) || Boolean(pending[token.id])}
                        onClick={() => void useToken(token.id, "copy")}
                      >
                        <Copy size={16} />
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        aria-label={`撤销 Token ${index + 1}`}
                        disabled={Boolean(busy) || Boolean(pending[token.id])}
                        onClick={() => void useToken(token.id, "revoke")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="access-token-empty">
                暂无 Token。申请后可查看、复制，并随时撤销。
              </p>
            )}
            {saved.require_apikey && !saved.tokens.length && (
              <p className="inline-error" role="alert">
                当前需要密钥，但尚无有效 Token。请申请 Token 后更新客户端配置。
              </p>
            )}
            <p className="info-access-hint">
              最多 5
              个，可供多个客户端使用。撤销立即生效；密钥仅在主动查看时显示。
            </p>
          </>
        ) : (
          <button
            className="button secondary btn btn--secondary small"
            onClick={() => void load()}
          >
            重新读取设置
          </button>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
      </section>
      <IntegrationPanels
        required={saved?.require_apikey ?? null}
        onNotice={onNotice}
      />
    </>
  );
}

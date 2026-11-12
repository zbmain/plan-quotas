import { useEffect, useId, useRef, useState } from "react";

type QuotaAlertSwitchProps = {
  enabled: boolean;
  pending: boolean;
  hint: string;
  onToggle: () => void;
};

/** 显示额度预警开关、功能说明及浏览器通知权限提示。 */
export function QuotaAlertSwitch({
  enabled,
  pending,
  hint,
  onToggle,
}: QuotaAlertSwitchProps) {
  const hintId = useId();
  const helpId = useId();
  const helpRef = useRef<HTMLSpanElement>(null);
  const [helpMode, setHelpMode] = useState<"hover" | "focus" | "pinned" | null>(
    null,
  );
  const helpVisible = helpMode !== null;

  useEffect(() => {
    if (!helpVisible) return;
    /** 按 Escape 或点击说明以外的位置时收起说明。 */
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpMode(null);
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !helpRef.current?.contains(event.target)
      )
        setHelpMode(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [helpVisible]);

  return (
    <div className="quota-alert-control">
      <div className="quota-alert-actions">
        <button
          type="button"
          className="quota-alert-switch"
          role="switch"
          aria-checked={enabled}
          aria-describedby={hint ? hintId : undefined}
          disabled={pending}
          onClick={onToggle}
        >
          <span>额度预警</span>
          <span className="quota-alert-track" aria-hidden="true">
            <span className="quota-alert-thumb" />
          </span>
        </button>
        <span
          className="quota-alert-help"
          ref={helpRef}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse")
              setHelpMode((current) => current ?? "hover");
          }}
          onPointerLeave={() =>
            setHelpMode((current) => (current === "hover" ? null : current))
          }
        >
          <button
            type="button"
            className="quota-alert-help-button"
            aria-label="额度预警说明"
            aria-expanded={helpVisible}
            aria-describedby={helpVisible ? helpId : undefined}
            onFocus={(event) => {
              if (event.currentTarget.matches(":focus-visible"))
                setHelpMode("focus");
            }}
            onBlur={() =>
              setHelpMode((current) => (current === "focus" ? null : current))
            }
            onClick={() =>
              setHelpMode((current) => (current === "pinned" ? null : "pinned"))
            }
          >
            <span aria-hidden="true">?</span>
          </button>
          <span
            id={helpId}
            className="quota-alert-help-panel"
            role="tooltip"
            hidden={!helpVisible}
          >
            周期额度剩余 20%、10%、0% 时会收到提醒
          </span>
        </span>
      </div>
      <span id={hintId} className="quota-alert-hint" role="status">
        {hint}
      </span>
    </div>
  );
}

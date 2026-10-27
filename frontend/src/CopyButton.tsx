import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "./clipboard";

/** Copy one value with short visual feedback and an explicit success or failure notice. */
export function CopyButton({
  text,
  label,
  successMessage,
  failureMessage = "复制失败，请手动选择并复制内容",
  size = 13,
  onNotice,
}: {
  text: string;
  label: string;
  successMessage: string;
  failureMessage?: string;
  size?: number;
  onNotice: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  /** Report only generic failure text; never put the copied value in errors or logs. */
  const copy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      await copyText(text);
      setCopied(true);
      onNotice(successMessage);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      onNotice(failureMessage);
    } finally {
      setCopying(false);
    }
  };

  return (
    <button
      type="button"
      className={`copy-button${copied ? " is-copied" : ""}`}
      aria-label={label}
      aria-busy={copying}
      title={copied ? "已复制" : label}
      disabled={copying}
      onClick={() => void copy()}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

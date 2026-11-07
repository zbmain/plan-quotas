import { Shapes } from "lucide-react";
import minimax from "./assets/providers/minimax.svg";
import glm from "./assets/providers/glm.svg";
import kimi from "./assets/providers/kimi.svg";
import deepseek from "./assets/providers/deepseek.svg";
import volcengine from "./assets/providers/volcengine.svg";
import aliyun from "./assets/providers/aliyun.svg";
import codex from "./assets/providers/codex.svg";
import claude from "./assets/providers/claude.svg";
import cursor from "./assets/providers/cursor.svg";
import opencode from "./assets/providers/opencode.svg";
import opendesign from "./assets/providers/opendesign.png";
import antigravity from "./assets/providers/antigravity.svg";

const icons: Record<string, string> = {
  minimax,
  glm,
  kimi,
  deepseek,
  volcengine,
  aliyun,
  codex,
  claude,
  cursor,
  opencode,
  opendesign,
  antigravity,
};
const monochrome = new Set([
  "kimi",
  "codex",
  "cursor",
  "opencode",
  "opendesign",
]);

/** Render a bundled brand mark without duplicating the adjacent accessible provider name. */
export function ProviderIcon({ provider }: { provider: string }) {
  const source = icons[provider];
  return (
    <span
      className={`provider-mark${monochrome.has(provider) ? " is-monochrome" : ""}`}
      data-provider={provider}
      aria-hidden="true"
    >
      {source ? (
        <img
          src={source}
          alt=""
          width={24}
          height={24}
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <Shapes size={20} />
      )}
    </span>
  );
}

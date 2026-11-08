import { MiniMaxAdapter, GLMAdapter, DeepSeekAdapter } from "./china.js";
import {
  KimiAdapter,
  VolcengineAdapter,
  AliyunAdapter,
} from "./china-extra.js";
import {
  CodexAdapter,
  ClaudeAdapter,
  CursorAdapter,
  AntigravityAdapter,
} from "./global.js";
import { OpenCodeAdapter } from "./opencode.js";
import { OpenDesignAdapter } from "./opendesign.js";
import { OpenAIAdapter } from "./openai.js";
import type { Adapter } from "./base.js";

/** Register all existing channels against the same typed collection contract. */
export function buildAdapters(): Record<string, Adapter> {
  return {
    minimax: new MiniMaxAdapter(),
    glm: new GLMAdapter(),
    kimi: new KimiAdapter(),
    deepseek: new DeepSeekAdapter(),
    volcengine: new VolcengineAdapter(),
    aliyun: new AliyunAdapter(),
    openai: new OpenAIAdapter(),
    codex: new CodexAdapter(),
    claude: new ClaudeAdapter(),
    cursor: new CursorAdapter(),
    opencode: new OpenCodeAdapter(),
    opendesign: new OpenDesignAdapter(),
    antigravity: new AntigravityAdapter(),
  };
}

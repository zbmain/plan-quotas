import { StoreError } from "./storage.js";

/** Explain recoverable startup failures without exposing arbitrary exception text or private paths. */
export function startupMessage(error: unknown): string {
  if (error instanceof StoreError) {
    if (
      error.message ===
      "encrypted credentials or access settings exist but master.key is missing"
    )
      return "启动失败：加密凭据或访问设置存在，但 master.key 缺失；请从同一份完整备份恢复主密钥。";
    if (error.message === "master.key has an invalid length")
      return "启动失败：master.key 格式不正确；请恢复与加密凭据配套的原主密钥。";
    if (error.message === "data directory is already in use")
      return "启动失败：数据目录已被其他实例锁定，请先停止旧实例。";
    if (
      [
        "encrypted access settings are missing",
        "encrypted access settings are unreadable",
      ].includes(error.message)
    )
      return "启动失败：api-access.enc 缺失或损坏；请从同一份完整备份恢复访问设置及 master.key。接口不会自动改为免密。";
  }
  return "启动失败：请检查配置、数据目录权限与完整备份。";
}

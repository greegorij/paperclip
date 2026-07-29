import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Apply requires explicit proof of a DB backup — it never creates/restores DB itself.
 *
 * Requires both:
 *   --backup-file <path> --backup-sha256 <hex>
 *
 * Soft confirm switches are intentionally unsupported.
 */
export function assertBackupGate({ backupFile = null, backupSha256 = null } = {}) {
  if (!backupFile || !backupSha256) {
    return {
      ok: false,
      mode: "missing",
      detail: "Provide --backup-file PATH and --backup-sha256 HEX (existing file + matching digest)",
    };
  }

  if (!existsSync(backupFile)) {
    return {
      ok: false,
      mode: "missing-file",
      detail: `Backup file not found: ${backupFile}`,
    };
  }

  const actual = createHash("sha256").update(readFileSync(backupFile)).digest("hex");
  if (actual.toLowerCase() !== String(backupSha256).toLowerCase()) {
    return {
      ok: false,
      mode: "sha-mismatch",
      detail: `Backup SHA-256 mismatch (file=${actual}, expected=${backupSha256})`,
    };
  }

  return {
    ok: true,
    mode: "file-sha",
    detail: `Backup verified: ${backupFile} sha256=${actual}`,
  };
}

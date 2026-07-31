import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TAIL_POLL_INTERVAL_MS = 10;
const DEFAULT_TAIL_READ_CHUNK_BYTES = 256 * 1024;

export type ChildStdioCaptureMode = "pipe" | "tempfile";

export interface TempStdioCaptureHandles {
  dir: string;
  stdoutPath: string;
  stderrPath: string;
  /** Write FDs to pass as child stdout/stderr; close in the parent after spawn. */
  stdoutWriteFd: number;
  stderrWriteFd: number;
}

export interface TempStdioFileTailer {
  /** Pause polling (backpressure). In-flight reads still finish. */
  pause(): void;
  resume(): void;
  /**
   * Stop the poll loop, drain remaining file bytes (and decoder flush), then
   * close the read FD. Safe to call more than once.
   */
  stop(): void;
}

export interface TempStdioCaptureSession {
  handles: TempStdioCaptureHandles;
  /** Close parent copies of the write FDs after spawn so only the child holds them. */
  releaseWriteFds(): void;
  stdoutTailer: TempStdioFileTailer;
  stderrTailer: TempStdioFileTailer;
  pause(): void;
  resume(): void;
  /** Final drain both streams, then delete the temp directory. */
  finalize(): Promise<void>;
}

/**
 * Open stdout/stderr temp files for a child process.
 *
 * The child writes to unbounded files instead of a small OS pipe, which avoids
 * Codex-style non-blocking writers treating a full 64 KiB pipe as fatal EAGAIN.
 */
export function createTempStdioCaptureHandles(): TempStdioCaptureHandles {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-child-stdio-"));
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  return {
    dir,
    stdoutPath,
    stderrPath,
    stdoutWriteFd: openSync(stdoutPath, "w"),
    stderrWriteFd: openSync(stderrPath, "w"),
  };
}

/**
 * Poll a growing file and emit UTF-8 text chunks as they appear.
 * Used while a child writes to the same path via a separate write FD.
 */
export function createTempStdioFileTailer(
  filePath: string,
  onChunk: (text: string) => void,
  options?: {
    pollIntervalMs?: number;
    readChunkBytes?: number;
    maxBytes?: number;
    onLimit?: () => void;
  },
): TempStdioFileTailer {
  const pollIntervalMs = Math.max(1, Math.floor(options?.pollIntervalMs ?? DEFAULT_TAIL_POLL_INTERVAL_MS));
  const readChunkBytes = Math.max(1, Math.floor(options?.readChunkBytes ?? DEFAULT_TAIL_READ_CHUNK_BYTES));
  const maxBytes = options?.maxBytes == null ? null : Math.max(1, Math.floor(options.maxBytes));
  const readFd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let paused = false;
  let stopped = false;
  let draining = false;
  let limitSignalled = false;

  const emit = (text: string) => {
    if (text.length === 0) return;
    onChunk(text);
  };

  const drainAvailable = (drainAll = false) => {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        if (!drainAll && paused) break;
        const size = fstatSync(readFd).size;
        if (maxBytes != null && size > maxBytes && !limitSignalled) {
          limitSignalled = true;
          options?.onLimit?.();
        }
        const readableSize = maxBytes == null ? size : Math.min(size, maxBytes);
        if (readableSize <= offset) break;
        const toRead = Math.min(readableSize - offset, readChunkBytes);
        const buf = Buffer.allocUnsafe(toRead);
        const bytesRead = readSync(readFd, buf, 0, toRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        emit(decoder.write(buf.subarray(0, bytesRead)));
        // One regular poll must not outrun the onLog backpressure decision made
        // synchronously by `onChunk`. Finalization is the sole deliberate full
        // drain, after the child has already exited.
        if (!drainAll || bytesRead < toRead) break;
      }
    } finally {
      draining = false;
    }
  };

  const timer = setInterval(() => {
    if (stopped || paused) return;
    try {
      drainAvailable();
    } catch {
      // Ignore transient read races; stop()/finalize will retry.
    }
  }, pollIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    pause() {
      paused = true;
    },
    resume() {
      if (stopped) return;
      paused = false;
      try {
        drainAvailable();
      } catch {
        // Best-effort; next poll tick retries.
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      paused = false;
      clearInterval(timer);
      try {
        drainAvailable(true);
        emit(decoder.end());
      } catch {
        // Final drain is best-effort.
      } finally {
        try {
          closeSync(readFd);
        } catch {
          // Ignore double-close races.
        }
      }
    },
  };
}

export function createTempStdioCaptureSession(
  onChunk: (stream: "stdout" | "stderr", text: string) => void,
  options?: {
    pollIntervalMs?: number;
    readChunkBytes?: number;
    maxBytes?: number;
    onLimit?: () => void;
  },
): TempStdioCaptureSession {
  const handles = createTempStdioCaptureHandles();
  let writeFdsReleased = false;
  let finalized = false;

  const stdoutTailer = createTempStdioFileTailer(
    handles.stdoutPath,
    (text) => onChunk("stdout", text),
    options,
  );
  const stderrTailer = createTempStdioFileTailer(
    handles.stderrPath,
    (text) => onChunk("stderr", text),
    options,
  );

  const releaseWriteFds = () => {
    if (writeFdsReleased) return;
    writeFdsReleased = true;
    try {
      closeSync(handles.stdoutWriteFd);
    } catch {
      // Ignore.
    }
    try {
      closeSync(handles.stderrWriteFd);
    } catch {
      // Ignore.
    }
  };

  return {
    handles,
    releaseWriteFds,
    stdoutTailer,
    stderrTailer,
    pause() {
      stdoutTailer.pause();
      stderrTailer.pause();
    },
    resume() {
      stdoutTailer.resume();
      stderrTailer.resume();
    },
    async finalize() {
      if (finalized) return;
      finalized = true;
      releaseWriteFds();
      stdoutTailer.stop();
      stderrTailer.stop();
      await fs.rm(handles.dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

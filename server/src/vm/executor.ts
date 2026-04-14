import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import { buildFirecrackerConfig, getRootfsPath } from "./config";
import type { ExecutionResult, ExecuteRequest } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Extra time on top of payload timeoutMs before SIGKILL — covers cold boot + sync + shutdown. */
const VM_HOST_OVERHEAD_MS = Number(
  process.env.VM_HOST_OVERHEAD_MS ?? 25_000
);
const MAX_CONCURRENT_VMS = Number(process.env.MAX_CONCURRENT_VMS ?? 2);

/** Logs full Firecracker stderr (truncated) per run. */
const EXEC_VM_DEBUG =
  process.env.EXEC_VM_DEBUG === "1" || process.env.EXEC_VM_DEBUG === "true";

/**
 * Adds full paths, `_result.json` preview, etc. Default logs stay size-safe.
 * Use with EXEC_VM_DEBUG for deep triage.
 */
const EXEC_VM_VERBOSE =
  process.env.EXEC_VM_VERBOSE === "1" || process.env.EXEC_VM_VERBOSE === "true";

type VmRunCtx = { runId: string };

function vmLog(
  msg: string,
  extra?: Record<string, unknown>,
  ctx?: VmRunCtx
): void {
  const payload =
    ctx === undefined
      ? extra
      : extra === undefined
        ? { runId: ctx.runId }
        : { runId: ctx.runId, ...extra };
  const line =
    payload === undefined
      ? `[vm-exec] ${msg}`
      : `[vm-exec] ${msg} ${JSON.stringify(payload)}`;
  console.error(line);
}

let activeVMs = 0;

export function getActiveVMCount(): number {
  return activeVMs;
}

export async function executeInVM(
  request: ExecuteRequest
): Promise<ExecutionResult> {
  if (activeVMs >= MAX_CONCURRENT_VMS) {
    throw new CapacityError("Server at capacity. Try again shortly.");
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vmId = uuid();
  const runId = vmId.slice(0, 8);
  const ctx: VmRunCtx = { runId };
  const vmDir = join(tmpdir(), `fc-${vmId}`);
  const runStarted = Date.now();

  activeVMs++;

  vmLog(
    "run start",
    {
      vmDir,
      language: request.language,
      timeoutMs,
      VM_HOST_OVERHEAD_MS,
      fileCount: request.files?.length ?? 0,
      codeChars: request.code?.length ?? 0,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      activeVMsIncludingThis: activeVMs,
      FIRECRACKER_DIR: process.env.FIRECRACKER_DIR ?? "/opt/firecracker",
    },
    ctx
  );

  try {
    await fs.mkdir(vmDir, { recursive: true });

    const baseRootfs = getRootfsPath(request.language);
    const vmRootfs = join(vmDir, "rootfs.ext4");
    try {
      await fs.access(baseRootfs);
    } catch {
      throw new Error(`Base rootfs not found or unreadable: ${baseRootfs}`);
    }
    const baseStat = await fs.stat(baseRootfs);
    const tCopy = Date.now();
    await fs.copyFile(baseRootfs, vmRootfs);
    const copyMs = Date.now() - tCopy;
    const copyStat = await fs.stat(vmRootfs);
    vmLog(
      "copied rootfs",
      {
        baseBytes: baseStat.size,
        copyBytes: copyStat.size,
        copyMs,
        language: request.language,
        ...(EXEC_VM_VERBOSE ? { baseRootfs, vmRootfs } : {}),
      },
      ctx
    );

    await injectPayload(vmRootfs, request, ctx);
    vmLog("payload injected", { vmRootfs: EXEC_VM_VERBOSE ? vmRootfs : "(see run start)" }, ctx);

    const config = buildFirecrackerConfig(vmRootfs);
    const configPath = join(vmDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf-8");
    vmLog(
      "firecracker config written",
      {
        kernel: config["boot-source"]?.kernel_image_path,
        bootArgs: config["boot-source"]?.boot_args,
        vcpus: config["machine-config"]?.vcpu_count,
        memMib: config["machine-config"]?.mem_size_mib,
        rootDrive: config.drives?.[0]?.path_on_host,
        ...(EXEC_VM_VERBOSE ? { configPath } : {}),
      },
      ctx
    );

    const socketPath = join(vmDir, "api.sock");
    const { result, firecrackerStderr } = await runFirecracker(
      socketPath,
      configPath,
      vmRootfs,
      timeoutMs,
      ctx
    );

    const merged = mergeFirecrackerDiagnostics(
      result,
      firecrackerStderr,
      ctx
    );
    vmLog(
      "run done",
      {
        totalMs: Date.now() - runStarted,
        exitCode: merged.exitCode,
        timedOut: merged.timedOut,
        stdoutChars: (merged.stdout ?? "").length,
        stderrChars: (merged.stderr ?? "").length,
      },
      ctx
    );
    return merged;
  } finally {
    activeVMs--;
    const tRm = Date.now();
    try {
      await fs.rm(vmDir, { recursive: true, force: true });
      vmLog(
        "vmDir cleanup ok",
        { rmMs: Date.now() - tRm, vmDir: EXEC_VM_VERBOSE ? vmDir : "(redacted)" },
        ctx
      );
    } catch (e) {
      vmLog(
        "vmDir cleanup failed",
        {
          vmDir: EXEC_VM_VERBOSE ? vmDir : "(redacted)",
          err: e instanceof Error ? e.message : String(e),
        },
        ctx
      );
    }
  }
}

async function injectPayload(
  rootfsPath: string,
  request: ExecuteRequest,
  ctx: VmRunCtx
): Promise<void> {
  const mountDir = join(tmpdir(), `fc-mount-${uuid()}`);
  await fs.mkdir(mountDir, { recursive: true });

  const files = request.files ?? [];
  const filesBytesApprox = files.reduce(
    (n, f) => n + (f.content_base64?.length ?? 0) * 0.75,
    0
  );

  try {
    const tMount = Date.now();
    const mOut = await execCommand("sudo", [
      "mount",
      "-o",
      "loop",
      rootfsPath,
      mountDir,
    ]);
    vmLog(
      "inject mount",
      {
        mountMs: Date.now() - tMount,
        exitCode: mOut.exitCode,
        mountDir: EXEC_VM_VERBOSE ? mountDir : "(tmp)",
        stderrTail: mOut.stderr ? mOut.stderr.slice(-400) : "",
      },
      ctx
    );
    if (mOut.exitCode !== 0) {
      throw new Error(
        `inject mount failed: ${mOut.stderr || mOut.stdout || "unknown"}`
      );
    }

    await chownMountToProcessUser(mountDir, ctx);

    const payload = {
      language: request.language,
      code: request.code,
      files,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const workspaceDir = join(mountDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const payloadJson = JSON.stringify(payload);
    await fs.writeFile(
      join(workspaceDir, "_payload.json"),
      payloadJson,
      "utf-8"
    );
    vmLog(
      "inject payload file",
      {
        payloadJsonBytes: Buffer.byteLength(payloadJson, "utf-8"),
        fileCount: files.length,
        filesBytesApprox: Math.round(filesBytesApprox),
        codeChars: request.code.length,
      },
      ctx
    );

    const tUm = Date.now();
    const uOut = await execCommand("sudo", ["umount", mountDir]);
    vmLog(
      "inject umount",
      {
        umountMs: Date.now() - tUm,
        exitCode: uOut.exitCode,
        stderrTail: uOut.stderr ? uOut.stderr.slice(-200) : "",
      },
      ctx
    );
  } finally {
    try {
      await execCommand("sudo", ["umount", mountDir]).catch(() => {});
      await fs.rm(mountDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // ignore
    }
  }
}

/** After sudo mount, the image is owned by root; chown so fs.writeFile works. */
async function chownMountToProcessUser(
  mountDir: string,
  ctx: VmRunCtx
): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) {
    vmLog("chown skipped (root or unsupported)", { uid, gid }, ctx);
    return;
  }
  const t0 = Date.now();
  const out = await execCommand("sudo", [
    "chown",
    "-R",
    `${uid}:${gid}`,
    mountDir,
  ]);
  vmLog(
    "chown mount",
    {
      uid,
      gid,
      ms: Date.now() - t0,
      exitCode: out.exitCode,
      stderrTail: out.stderr ? out.stderr.slice(-200) : "",
    },
    ctx
  );
}

function mergeFirecrackerDiagnostics(
  result: ExecutionResult,
  firecrackerStderr: string,
  ctx: VmRunCtx
): ExecutionResult {
  const trimmed = firecrackerStderr.trim();
  const isReadFail =
    result.stderr.startsWith("Failed to read execution result from VM") ||
    result.stderr === "Execution timed out";
  if (!trimmed || !isReadFail) {
    return result;
  }
  let hint = trimmed;
  if (trimmed.includes("Kvm(Error(13))") || trimmed.includes("Error(13)")) {
    hint +=
      "\n\nHint: errno 13 on KVM usually means this user cannot open /dev/kvm. " +
      "Run: sudo usermod -aG kvm $USER  then log out and SSH back in (or: newgrp kvm).";
  }
  vmLog(
    "appending firecracker stderr to client error",
    { stderrChars: trimmed.length },
    ctx
  );
  return { ...result, stderr: `${result.stderr}\n\nFirecracker: ${hint}` };
}

async function runFirecracker(
  socketPath: string,
  configPath: string,
  rootfsPath: string,
  timeoutMs: number,
  ctx: VmRunCtx
): Promise<{ result: ExecutionResult; firecrackerStderr: string }> {
  return new Promise((resolve) => {
    const totalTimeout = timeoutMs + VM_HOST_OVERHEAD_MS;
    let timedOut = false;
    let timerFired = false;
    let firecrackerStderr = "";
    const startedAt = Date.now();

    vmLog(
      "starting firecracker",
      {
        timeoutMs,
        VM_HOST_OVERHEAD_MS,
        totalTimeoutMs: totalTimeout,
        socketPath: EXEC_VM_VERBOSE ? socketPath : "(tmp)",
        configPath: EXEC_VM_VERBOSE ? configPath : "(tmp)",
      },
      ctx
    );

    // Guest serial → Firecracker's stdout. If stdout is a pipe and we never read it,
    // the buffer fills and the VMM can block (symptom: ~15s hangs, no _result.json).
    const child = spawn(
      "firecracker",
      ["--api-sock", socketPath, "--config-file", configPath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    vmLog("firecracker child spawned", { pid: child.pid }, ctx);

    child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8");
      firecrackerStderr += msg;
      const line = msg.trim();
      if (line) console.error(`[firecracker][${ctx.runId}] ${line}`);
    });

    const timer = setTimeout(() => {
      timerFired = true;
      timedOut = true;
      vmLog(
        "host timer expired, SIGKILL firecracker",
        {
          totalTimeoutMs: totalTimeout,
          elapsedMs: Date.now() - startedAt,
          pid: child.pid,
        },
        ctx
      );
      child.kill("SIGKILL");
    }, totalTimeout);

    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      vmLog(
        "firecracker exited",
        {
          code,
          signal,
          elapsedMs,
          hostTimerFired: timerFired,
          stderrChars: firecrackerStderr.length,
          pid: child.pid,
        },
        ctx
      );
      if (EXEC_VM_DEBUG && firecrackerStderr) {
        vmLog(
          "firecracker stderr (full)",
          { text: firecrackerStderr.slice(0, 8000) },
          ctx
        );
      }
      const tRead = Date.now();
      const result = await readResult(rootfsPath, timedOut, rootfsPath, ctx);
      vmLog(
        "readResult finished",
        { readResultMs: Date.now() - tRead },
        ctx
      );
      resolve({ result, firecrackerStderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      vmLog("firecracker spawn error", { message: err.message }, ctx);
      resolve({
        result: {
          stdout: "",
          stderr: `Firecracker failed to start: ${err.message}`,
          exitCode: null,
          timedOut: false,
        },
        firecrackerStderr,
      });
    });
  });
}

async function readResult(
  rootfsPath: string,
  timedOut: boolean,
  imagePathForLog: string,
  ctx: VmRunCtx
): Promise<ExecutionResult> {
  const mountDir = join(tmpdir(), `fc-read-${uuid()}`);
  await fs.mkdir(mountDir, { recursive: true });

  let imgStat: { size: number } | null = null;
  try {
    const st = await fs.stat(rootfsPath);
    imgStat = { size: st.size };
  } catch {
    // ignore
  }

  try {
    // After the guest runs, ext4 often has a dirty journal. `loop,ro` can fail with
    // "cannot mount ... read-only" until replay. RW mount replays the journal; we only
    // read _result.json and discard this image copy immediately after.
    const tMount = Date.now();
    const mountOut = await execCommand("sudo", [
      "mount",
      "-o",
      "loop",
      rootfsPath,
      mountDir,
    ]);
    vmLog(
      "readResult mount",
      {
        mountMs: Date.now() - tMount,
        exitCode: mountOut.exitCode,
        imageBytes: imgStat?.size,
        mountMode: "rw",
      },
      ctx
    );
    if (mountOut.exitCode !== 0) {
      vmLog(
        "readResult mount failed",
        {
          imagePathForLog: EXEC_VM_VERBOSE ? imagePathForLog : "(path redacted)",
          stderr: mountOut.stderr,
          stdout: mountOut.stdout,
          exitCode: mountOut.exitCode,
        },
        ctx
      );
      return {
        stdout: "",
        stderr: timedOut
          ? "Execution timed out"
          : `Failed to mount rootfs for read: ${mountOut.stderr || mountOut.stdout || "mount failed"}`,
        exitCode: null,
        timedOut,
      };
    }

    const workspaceDir = join(mountDir, "workspace");
    const resultPath = join(workspaceDir, "_result.json");
    let workspaceListing: string[] = [];
    try {
      workspaceListing = await fs.readdir(workspaceDir);
    } catch (e) {
      vmLog(
        "readResult workspace readdir failed",
        {
          workspaceDir,
          err: e instanceof Error ? e.message : String(e),
        },
        ctx
      );
    }

    try {
      const st = await fs.stat(resultPath);
      vmLog(
        "readResult _result.json found",
        {
          size: st.size,
          workspaceFiles: workspaceListing,
        },
        ctx
      );
      const data = await fs.readFile(resultPath, "utf-8");
      if (EXEC_VM_VERBOSE) {
        vmLog(
          "readResult raw json",
          { preview: data.slice(0, 500), totalChars: data.length },
          ctx
        );
      }
      const result = JSON.parse(data) as ExecutionResult;
      if (timedOut) result.timedOut = true;
      vmLog(
        "readResult parsed",
        {
          guestExitCode: result.exitCode,
          guestTimedOut: result.timedOut,
          stdoutChars: (result.stdout ?? "").length,
          stderrChars: (result.stderr ?? "").length,
        },
        ctx
      );
      return result;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const isParse =
        e instanceof SyntaxError ||
        (e instanceof Error && e.message.includes("JSON"));
      vmLog(
        "readResult failed",
        {
          resultPath,
          workspaceFiles: workspaceListing,
          err: errMsg,
          likelyJsonParse: isParse,
          timedOut,
          imagePathForLog: EXEC_VM_VERBOSE ? imagePathForLog : "(redacted)",
        },
        ctx
      );
      return {
        stdout: "",
        stderr: timedOut
          ? "Execution timed out"
          : `Failed to read execution result from VM (${errMsg}). Workspace: ${workspaceListing.join(", ") || "(none)"}`,
        exitCode: null,
        timedOut,
      };
    }
  } finally {
    try {
      const tu = Date.now();
      const u = await execCommand("sudo", ["umount", mountDir]).catch(
        () =>
          ({
            stdout: "",
            stderr: "umount threw",
            exitCode: -1,
          }) as const
      );
      vmLog(
        "readResult umount",
        { umountMs: Date.now() - tu, exitCode: u.exitCode },
        ctx
      );
      await fs.rm(mountDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // ignore
    }
  }
}

function execCommand(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    child.on("error", reject);
  });
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

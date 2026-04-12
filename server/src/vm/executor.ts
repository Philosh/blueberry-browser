import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import { buildFirecrackerConfig, getRootfsPath } from "./config";
import type { ExecutionResult, ExecuteRequest } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_BUFFER_MS = 5_000;
const MAX_CONCURRENT_VMS = Number(process.env.MAX_CONCURRENT_VMS ?? 15);

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
  const vmDir = join(tmpdir(), `fc-${vmId}`);

  activeVMs++;

  try {
    await fs.mkdir(vmDir, { recursive: true });

    const baseRootfs = getRootfsPath(request.language);
    const vmRootfs = join(vmDir, "rootfs.ext4");
    await fs.copyFile(baseRootfs, vmRootfs);

    await injectPayload(vmRootfs, request);

    const config = buildFirecrackerConfig(vmRootfs);
    const configPath = join(vmDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf-8");

    const socketPath = join(vmDir, "api.sock");
    const { result, firecrackerStderr } = await runFirecracker(
      socketPath,
      configPath,
      vmRootfs,
      timeoutMs
    );

    return mergeFirecrackerDiagnostics(result, firecrackerStderr);
  } finally {
    activeVMs--;
    try {
      await fs.rm(vmDir, { recursive: true, force: true });
    } catch {
      console.error(`Failed to clean up VM dir: ${vmDir}`);
    }
  }
}

async function injectPayload(
  rootfsPath: string,
  request: ExecuteRequest
): Promise<void> {
  const mountDir = join(tmpdir(), `fc-mount-${uuid()}`);
  await fs.mkdir(mountDir, { recursive: true });

  try {
    await execCommand("sudo", ["mount", "-o", "loop", rootfsPath, mountDir]);
    // Loop-mounted ext4 is root-owned; Node runs as a normal user — grant write access.
    await chownMountToProcessUser(mountDir);

    const payload = {
      language: request.language,
      code: request.code,
      files: request.files ?? [],
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const workspaceDir = join(mountDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      join(workspaceDir, "_payload.json"),
      JSON.stringify(payload),
      "utf-8"
    );

    await execCommand("sudo", ["umount", mountDir]);
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
async function chownMountToProcessUser(mountDir: string): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) {
    return;
  }
  await execCommand("sudo", ["chown", "-R", `${uid}:${gid}`, mountDir]);
}

function mergeFirecrackerDiagnostics(
  result: ExecutionResult,
  firecrackerStderr: string
): ExecutionResult {
  const trimmed = firecrackerStderr.trim();
  if (
    !trimmed ||
    (result.stderr !== "Failed to read execution result from VM" &&
      result.stderr !== "Execution timed out")
  ) {
    return result;
  }
  let hint = trimmed;
  if (trimmed.includes("Kvm(Error(13))") || trimmed.includes("Error(13)")) {
    hint +=
      "\n\nHint: errno 13 on KVM usually means this user cannot open /dev/kvm. " +
      "Run: sudo usermod -aG kvm $USER  then log out and SSH back in (or: newgrp kvm).";
  }
  return { ...result, stderr: `${result.stderr}\n\nFirecracker: ${hint}` };
}

async function runFirecracker(
  socketPath: string,
  configPath: string,
  rootfsPath: string,
  timeoutMs: number
): Promise<{ result: ExecutionResult; firecrackerStderr: string }> {
  return new Promise((resolve) => {
    const totalTimeout = timeoutMs + TIMEOUT_BUFFER_MS;
    let timedOut = false;
    let firecrackerStderr = "";

    const child = spawn(
      "firecracker",
      ["--api-sock", socketPath, "--config-file", configPath],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8");
      firecrackerStderr += msg;
      const line = msg.trim();
      if (line) console.error(`[firecracker] ${line}`);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, totalTimeout);

    child.on("close", async () => {
      clearTimeout(timer);
      const result = await readResult(rootfsPath, timedOut);
      resolve({ result, firecrackerStderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
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
  timedOut: boolean
): Promise<ExecutionResult> {
  const mountDir = join(tmpdir(), `fc-read-${uuid()}`);
  await fs.mkdir(mountDir, { recursive: true });

  try {
    await execCommand("sudo", ["mount", "-o", "loop,ro", rootfsPath, mountDir]);

    const resultPath = join(mountDir, "workspace", "_result.json");
    try {
      const data = await fs.readFile(resultPath, "utf-8");
      const result = JSON.parse(data) as ExecutionResult;
      if (timedOut) result.timedOut = true;
      return result;
    } catch {
      return {
        stdout: "",
        stderr: timedOut
          ? "Execution timed out"
          : "Failed to read execution result from VM",
        exitCode: null,
        timedOut,
      };
    }
  } finally {
    try {
      await execCommand("sudo", ["umount", mountDir]).catch(() => {});
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

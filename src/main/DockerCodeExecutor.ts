import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";

export type CodeLanguage = "python" | "javascript";

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class DockerCodeExecutor {
  private readonly pythonImage: string;
  private readonly nodeImage: string;
  private readonly timeoutMs: number;

  constructor(opts?: { pythonImage?: string; nodeImage?: string; timeoutMs?: number }) {
    this.pythonImage =
      opts?.pythonImage ?? process.env.DOCKER_PYTHON_IMAGE ?? "blueberry-python:3.11";
    this.nodeImage = opts?.nodeImage ?? process.env.DOCKER_NODE_IMAGE ?? "node:20-slim";
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.CODE_EXEC_TIMEOUT_MS ?? 30_000);
  }

  async execute(opts: {
    language: CodeLanguage;
    code: string;
    workspaceDir: string;
  }): Promise<ExecutionResult> {
    const { language, code, workspaceDir } = opts;
    const execId = randomUUID();

    if (language === "python") {
      await this.ensurePythonImage();
    }

    const fileName = language === "python" ? `__blueberry_exec_${execId}.py` : `__blueberry_exec_${execId}.js`;
    const codePath = join(workspaceDir, fileName);

    // Write code into the sandbox workspace; the container will mount this dir.
    await fs.writeFile(codePath, code, "utf-8");

    const image = language === "python" ? this.pythonImage : this.nodeImage;
    const fileInContainer = `/workspace/${fileName}`;
    // Use unbuffered mode for Python so output is flushed reliably.
    const runCmd =
      language === "python"
        ? ["python3", "-u", fileInContainer]
        : ["node", fileInContainer];

    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--security-opt",
        "no-new-privileges",
        "-v",
        `${workspaceDir}:/workspace:rw`,
        "-w",
        "/workspace",
        image,
        ...runCmd,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    clearTimeout(timeout);

    // Best-effort cleanup of the generated code file.
    try {
      await fs.unlink(codePath);
    } catch {
      // ignore
    }

    return { stdout, stderr, exitCode, timedOut };
  }

  private async ensurePythonImage(): Promise<void> {
    // If the default image is overridden, assume the user manages it.
    if (this.pythonImage !== "blueberry-python:3.11") return;

    const inspect = await this.execDocker(["image", "inspect", this.pythonImage]);
    if (inspect.exitCode === 0) return;

    // Build a local image from the repo Dockerfile (dev-friendly).
    // For packaged apps, you’d typically publish this image and set DOCKER_PYTHON_IMAGE.
    const repoRoot = process.cwd();
    const dockerfilePath = join(repoRoot, "docker/blueberry-python/Dockerfile");

    const build = await this.execDocker([
      "build",
      "-t",
      this.pythonImage,
      "-f",
      dockerfilePath,
      repoRoot,
    ]);

    if (build.exitCode !== 0) {
      throw new Error(
        `Failed to build ${this.pythonImage}. Please ensure Docker is running.\n` +
          (build.stderr || build.stdout)
      );
    }
  }

  private execDocker(args: string[]): Promise<ExecutionResult> {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    return new Promise((resolve) => {
      child.on("close", (code) =>
        resolve({ stdout, stderr, exitCode: code, timedOut: false })
      );
      child.on("error", () =>
        resolve({ stdout, stderr, exitCode: null, timedOut: false })
      );
    });
  }
}


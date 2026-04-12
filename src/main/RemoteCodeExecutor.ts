import { promises as fs } from "fs";
import { basename, join } from "path";
import type { CodeLanguage, ExecutionResult } from "./DockerCodeExecutor";

export class RemoteCodeExecutor {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts?: { apiUrl?: string; apiKey?: string; timeoutMs?: number }) {
    this.apiUrl = opts?.apiUrl ?? process.env.CODE_EXEC_API_URL ?? "";
    this.apiKey = opts?.apiKey ?? process.env.CODE_EXEC_API_KEY ?? "";
    this.timeoutMs =
      opts?.timeoutMs ?? Number(process.env.CODE_EXEC_TIMEOUT_MS ?? 30_000);
  }

  async execute(opts: {
    language: CodeLanguage;
    code: string;
    workspaceDir: string;
  }): Promise<ExecutionResult> {
    const { language, code, workspaceDir } = opts;

    if (!this.apiUrl) {
      return {
        stdout: "",
        stderr:
          "CODE_EXEC_API_URL is not set. Add it to .env (full URL including /execute).",
        exitCode: null,
        timedOut: false,
      };
    }

    const files = await this.readWorkspaceFiles(workspaceDir);

    const body = JSON.stringify({
      language,
      code,
      files,
      timeoutMs: this.timeoutMs,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // Server waits up to timeoutMs + VM boot/shutdown overhead (~25s default).
    const clientTimeoutMs = this.timeoutMs + 40_000;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), clientTimeoutMs);

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        return (await response.json()) as ExecutionResult;
      }

      return this.mapHttpError(response.status, await response.text());
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          stdout: "",
          stderr:
            "Code execution request timed out. The server may be overloaded.",
          exitCode: null,
          timedOut: true,
        };
      }

      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        stdout: "",
        stderr: `Failed to reach code execution service: ${message}`,
        exitCode: null,
        timedOut: false,
      };
    }
  }

  private mapHttpError(status: number, body: string): ExecutionResult {
    let stderr: string;
    switch (status) {
      case 401:
        stderr =
          "Code execution service rejected the API key. Check CODE_EXEC_API_KEY.";
        break;
      case 429:
        stderr = "Rate limited. Try again shortly.";
        break;
      case 503:
        stderr = "Code execution service is at capacity. Try again shortly.";
        break;
      default: {
        let detail = "";
        try {
          const parsed = JSON.parse(body) as { error?: string };
          detail = parsed.error ?? "";
        } catch {
          detail = body.slice(0, 200);
        }
        stderr = `Code execution error ${status}${detail ? `: ${detail}` : ""}`;
      }
    }
    return { stdout: "", stderr, exitCode: null, timedOut: false };
  }

  private async readWorkspaceFiles(
    dir: string
  ): Promise<Array<{ name: string; content_base64: string }>> {
    const result: Array<{ name: string; content_base64: string }> = [];

    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith("__blueberry_exec_")) continue;
        if (entry.startsWith("_payload") || entry.startsWith("_result")) continue;

        const filePath = join(dir, entry);
        const stat = await fs.stat(filePath);

        if (!stat.isFile() || stat.size > 50 * 1024 * 1024) continue;

        const content = await fs.readFile(filePath);
        result.push({
          name: basename(entry),
          content_base64: content.toString("base64"),
        });
      }
    } catch {
      // empty workspace
    }

    return result;
  }
}

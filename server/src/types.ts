export type CodeLanguage = "python" | "javascript";

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ExecuteRequest {
  language: CodeLanguage;
  code: string;
  files: Array<{ name: string; content_base64: string }>;
  timeoutMs?: number;
}

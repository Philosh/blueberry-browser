import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join, extname, basename } from "path";
import { promises as fs } from "fs";

export interface SandboxFile {
  id: string;
  name: string;
  sandboxPath: string;
  mimeType: string;
  size: number;
}

export type FileManifest = Omit<SandboxFile, "sandboxPath">;

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "text/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".jsx": "text/jsx",
  ".tsx": "text/tsx",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".sql": "text/x-sql",
  ".log": "text/plain",
  ".env": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm",
  ".css", ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go",
  ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".sh", ".bash",
  ".zsh", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".sql", ".graphql", ".svelte", ".vue", ".swift",
  ".kt", ".scala", ".r", ".m", ".mm", ".lua", ".pl", ".php",
  ".log", ".gitignore", ".makefile",
]);

export class SandboxManager {
  private sessionId: string | null = null;
  private sandboxDir: string | null = null;
  private files = new Map<string, SandboxFile>();

  async ensureSession(): Promise<string> {
    if (this.sessionId && this.sandboxDir) {
      return this.sessionId;
    }
    this.sessionId = randomUUID();
    this.sandboxDir = join(tmpdir(), `blueberry-sandbox-${this.sessionId}`);
    await fs.mkdir(this.sandboxDir, { recursive: true });
    return this.sessionId;
  }

  async addFiles(sourcePaths: string[]): Promise<FileManifest[]> {
    await this.ensureSession();

    for (const sourcePath of sourcePaths) {
      const stat = await fs.stat(sourcePath);
      if (stat.size > MAX_FILE_SIZE) {
        console.warn(
          `Skipping ${sourcePath}: exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`
        );
        continue;
      }

      const fileId = randomUUID();
      const originalName = basename(sourcePath);
      const destName = this.deduplicateName(originalName);
      const destPath = join(this.sandboxDir!, destName);

      await fs.copyFile(sourcePath, destPath);

      const ext = extname(originalName).toLowerCase();
      const mimeType = MIME_MAP[ext] || "application/octet-stream";

      this.files.set(fileId, {
        id: fileId,
        name: destName,
        sandboxPath: destPath,
        mimeType,
        size: stat.size,
      });
    }

    return this.getManifest();
  }

  async removeFile(fileId: string): Promise<FileManifest[]> {
    const file = this.files.get(fileId);
    if (file) {
      try {
        await fs.unlink(file.sandboxPath);
      } catch {
        // File already deleted
      }
      this.files.delete(fileId);
    }
    return this.getManifest();
  }

  getManifest(): FileManifest[] {
    return Array.from(this.files.values()).map(
      ({ sandboxPath: _, ...rest }) => rest
    );
  }

  async readFileContents(
    fileId: string
  ): Promise<{ text?: string; dataUrl?: string } | null> {
    const file = this.files.get(fileId);
    if (!file) return null;

    const ext = extname(file.name).toLowerCase();

    if (file.mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
      const text = await fs.readFile(file.sandboxPath, "utf-8");
      return { text };
    }

    if (file.mimeType.startsWith("image/")) {
      const buf = await fs.readFile(file.sandboxPath);
      const b64 = buf.toString("base64");
      return { dataUrl: `data:${file.mimeType};base64,${b64}` };
    }

    return { text: `[Binary file: ${file.name}, ${file.size} bytes]` };
  }

  getAllFiles(): SandboxFile[] {
    return Array.from(this.files.values());
  }

  getSandboxDir(): string | null {
    return this.sandboxDir;
  }

  hasFiles(): boolean {
    return this.files.size > 0;
  }

  async destroySession(): Promise<void> {
    if (this.sandboxDir) {
      try {
        await fs.rm(this.sandboxDir, { recursive: true, force: true });
      } catch (err) {
        console.error("Failed to clean up sandbox:", err);
      }
    }
    this.files.clear();
    this.sessionId = null;
    this.sandboxDir = null;
  }

  async cleanupAll(): Promise<void> {
    await this.destroySession();
  }

  private deduplicateName(name: string): string {
    const existing = new Set(
      Array.from(this.files.values()).map((f) => f.name)
    );
    if (!existing.has(name)) return name;

    const ext = extname(name);
    const base = basename(name, ext);
    let counter = 1;
    let candidate: string;
    do {
      candidate = `${base} (${counter})${ext}`;
      counter++;
    } while (existing.has(candidate));
    return candidate;
  }
}

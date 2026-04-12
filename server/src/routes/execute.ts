import type { FastifyInstance } from "fastify";
import { executeInVM, CapacityError } from "../vm/executor";
import type { ExecuteRequest } from "../types";

const MAX_CODE_SIZE = 30_000;
const MAX_TOTAL_FILES_SIZE = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 50;
const VALID_LANGUAGES = new Set(["python", "javascript"]);

export async function executeRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
    const body = request.body;

    if (!body?.language || !VALID_LANGUAGES.has(body.language)) {
      return reply.code(400).send({
        error: `Invalid language. Must be one of: ${[...VALID_LANGUAGES].join(", ")}`,
      });
    }

    if (!body.code || typeof body.code !== "string") {
      return reply.code(400).send({ error: "Missing or invalid 'code' field" });
    }
    if (body.code.length > MAX_CODE_SIZE) {
      return reply.code(400).send({
        error: `Code exceeds maximum size of ${MAX_CODE_SIZE} bytes`,
      });
    }

    const files = body.files ?? [];
    if (!Array.isArray(files)) {
      return reply.code(400).send({ error: "'files' must be an array" });
    }
    if (files.length > MAX_FILE_COUNT) {
      return reply.code(400).send({
        error: `Too many files. Maximum is ${MAX_FILE_COUNT}`,
      });
    }

    let totalFilesSize = 0;
    for (const file of files) {
      if (!file.name || typeof file.name !== "string") {
        return reply.code(400).send({ error: "Each file must have a 'name'" });
      }
      if (!file.content_base64 || typeof file.content_base64 !== "string") {
        return reply
          .code(400)
          .send({ error: "Each file must have 'content_base64'" });
      }
      totalFilesSize += (file.content_base64.length * 3) / 4;
    }
    if (totalFilesSize > MAX_TOTAL_FILES_SIZE) {
      return reply.code(400).send({
        error: `Total files size exceeds maximum of ${MAX_TOTAL_FILES_SIZE / (1024 * 1024)}MB`,
      });
    }

    const timeoutMs = body.timeoutMs ?? 30_000;
    if (
      typeof timeoutMs !== "number" ||
      timeoutMs < 1000 ||
      timeoutMs > 60_000
    ) {
      return reply.code(400).send({
        error: "timeoutMs must be between 1000 and 60000",
      });
    }

    try {
      const result = await executeInVM({
        language: body.language,
        code: body.code,
        files,
        timeoutMs,
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof CapacityError) {
        return reply.code(503).send({ error: err.message });
      }
      console.error("Execution error:", err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
}

import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { authHook } from "./auth";
import { executeRoute } from "./routes/execute";
import { getActiveVMCount } from "./vm/executor";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isHealthCheckRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?")[0] ?? "";
  return path === "/health";
}

async function main(): Promise<void> {
  const trustProxy =
    process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

  const rateLimitMax = parseEnvInt("RATE_LIMIT_MAX", 30);
  const rateLimitWindowMs = Math.max(
    1000,
    parseEnvInt("RATE_LIMIT_WINDOW_MS", 60_000)
  );

  const app = Fastify({
    logger: true,
    bodyLimit: 55 * 1024 * 1024,
    trustProxy,
  });

  if (rateLimitMax > 0) {
    await app.register(rateLimit, {
      max: rateLimitMax,
      timeWindow: rateLimitWindowMs,
      /** LB health checks must not consume the per-client budget. */
      allowList: (request) => isHealthCheckRequest(request),
    });
  }

  app.addHook("onRequest", authHook);

  await app.register(executeRoute);

  app.get("/health", async () => ({
    status: "ok",
    activeVMs: getActiveVMCount(),
    timestamp: new Date().toISOString(),
  }));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Blueberry exec server listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();

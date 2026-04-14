import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { authHook } from "./auth";
import { executeRoute } from "./routes/execute";
import { getActiveVMCount } from "./vm/executor";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

function isHealthCheckRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?")[0] ?? "";
  return path === "/health";
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
    bodyLimit: 55 * 1024 * 1024,
    // Behind a load balancer, trust X-Forwarded-For for request.ip.
    trustProxy: true,
  });

  // Demo-friendly: raise the global rate limit.
  // NOTE: /health is excluded so probes + monitoring do not burn the budget.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    allowList: (request) => isHealthCheckRequest(request),
  });

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

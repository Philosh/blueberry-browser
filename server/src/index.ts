import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { authHook } from "./auth";
import { executeRoute } from "./routes/execute";
import { getActiveVMCount } from "./vm/executor";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
    bodyLimit: 55 * 1024 * 1024,
  });

  await app.register(rateLimit, {
    max: 30,
    timeWindow: "1 minute",
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

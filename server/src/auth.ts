import type { FastifyRequest, FastifyReply } from "fastify";

const API_KEY = process.env.BLUEBERRY_API_KEY ?? "";

export async function authHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (request.url.split("?")[0] === "/health") {
    return;
  }

  if (!API_KEY) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== API_KEY) {
    reply.code(401).send({ error: "Invalid API key" });
  }
}

import fp from "fastify-plugin";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production"
);

export const authPlugin = fp(async (fastify) => {
  // JWT sign helper
  fastify.decorate("signJwt", async (payload: Record<string, unknown>) => {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("24h")
      .sign(JWT_SECRET);
  });

  // JWT verify helper
  fastify.decorate("verifyJwt", async (token: string) => {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  });

  // Auth preHandler hook
  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    try {
      const token = authHeader.slice(7);
      request.user = await fastify.verifyJwt(token);
    } catch {
      reply.code(401).send({ error: "Invalid or expired token" });
    }
  });
}, { name: "auth", dependencies: ["config"] });

declare module "fastify" {
  interface FastifyInstance {
    signJwt: (payload: Record<string, unknown>) => Promise<string>;
    verifyJwt: (token: string) => Promise<Record<string, unknown>>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: Record<string, unknown>;
  }
}

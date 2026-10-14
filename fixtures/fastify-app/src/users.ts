import type { FastifyInstance } from "fastify";

export default async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/", listUsers);
  fastify.get("/:id", getUser);
  fastify.register(
    async function accountRoutes(account: FastifyInstance) {
      account.get("/settings", getSettings);
    },
    { prefix: "/account" },
  );
}

export function listUsers(): void {}
export function getUser(): void {}
export function getSettings(): void {}

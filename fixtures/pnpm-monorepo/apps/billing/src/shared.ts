import { Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute, validator as zValidator } from "hono-openapi";

export const createSharedRoutes = (deps: { service: string }) => {
  const app = new Hono();

  app.use("*", cors());

  app.get(
    "/account-info",
    describeRoute({
      operationId: "getAccountInfo",
      summary: "Account info",
      description: "Look up an account by code",
    }),
    zValidator("query", { code: deps.service }),
    async (c) => {
      return c.json({ service: deps.service });
    },
  );

  app.get(
    "/project-info",
    describeRoute({ description: "Project info without a short name" }),
    (c) => c.json({ ok: true }),
  );

  return app;
};

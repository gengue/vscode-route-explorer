import { Hono } from "hono";
import { describeRoute, validator as zValidator } from "hono-openapi";

export function createGetMessageRoutes() {
  const app = new Hono();

  app.post(
    "/",
    describeRoute({
      operationId: "getMessage",
      summary: "Get a message",
    }),
    zValidator("json", { id: "message" }),
    async (c) => c.json({ id: "message" }),
  );

  return app;
}

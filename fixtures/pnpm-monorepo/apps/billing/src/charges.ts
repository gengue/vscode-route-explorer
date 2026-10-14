import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

export function createChargeRoutes(deps: { service: string }) {
  const app = new Hono();

  app.post(
    "/",
    describeRoute({ summary: "Create a charge" }),
    (c) => c.json({ service: deps.service }),
  );

  return app;
}

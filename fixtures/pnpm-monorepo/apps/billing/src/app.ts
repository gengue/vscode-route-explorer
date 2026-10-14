import { Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute } from "hono-openapi";
import { createChargeRoutes } from "@/charges";
import { createSharedRoutes } from "@/shared";

interface CreateAppDeps {
  service?: string;
}

export function createApp(deps: CreateAppDeps = {}) {
  const service = deps.service ?? "billing";
  const app = new Hono();

  app.use("*", cors());

  app.get(
    "/health",
    describeRoute({ operationId: "getHealth", summary: "Health check" }),
    (c) => c.json({ status: "ok", service }),
  );

  app.route("/", createSharedRoutes({ service }));
  app.route("/charges", createChargeRoutes({ service }));

  return app;
}

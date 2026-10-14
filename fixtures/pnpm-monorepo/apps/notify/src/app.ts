import { Hono } from "hono";
import { cors } from "hono/cors";
import { createJobRoutes } from "./jobs/index.js";
import { createGetMessageRoutes } from "./tools/get-message.js";

export function createApp() {
  const app = new Hono();

  app.use("*", cors({ origin: "*" }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/jobs", createJobRoutes());
  app.route("/get-message", createGetMessageRoutes());

  return app;
}

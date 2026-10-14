import { Hono } from "hono";

export function createJobRoutes() {
  const app = new Hono();
  app.get("/", function listJobs() {});
  return app;
}

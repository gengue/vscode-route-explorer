import express, { Router } from "express";

const PREFIX = "/admin";

export function createApp() {
  const app = express();
  const api = Router();
  const items = Router();

  items.get("/:id", getItem);
  api.use("/items", items);
  app.use("/api", api);
  app.use(express.json());

  app.get("/health", health);
  app.get(`${PREFIX}/stats`, stats);
  app.route("/session").get(getSession).post(createSession);
  app.get(["/a", "/b"], multi);
  app.post("/jobs", auth, createJob);
  app.patch("/jobs/:id", patchJob);
  app.head("/jobs/:id", headJob);
  app.options("/jobs", optionsJob);
  app.all("/hooks", allHooks);

  return app;
}

function getItem(): void {}
function health(): void {}
function stats(): void {}
function getSession(): void {}
function createSession(): void {}
function multi(): void {}
function auth(): void {}
function createJob(): void {}
function patchJob(): void {}
function headJob(): void {}
function optionsJob(): void {}
function allHooks(): void {}

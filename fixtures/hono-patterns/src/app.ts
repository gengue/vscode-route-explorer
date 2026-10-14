import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Hono } from "hono";
import { books } from "./books";

const app = new Hono().basePath("/api");

export function health(): void {}
export function ready(): void {}
export function ping(): void {}
export function echo(): void {}
export function inlineGet(): void {}
export function inlinePost(): void {}
export function one(): void {}
export function two(): void {}
export function statusHandler(): void {}
export function createStatus(): void {}
export function allHooks(): void {}

app.get("/health", health).get("/ready", ready);
app.post("/ping", ping).put("/ping", echo);

const inline = new Hono().get("/inline", inlineGet).post("/inline", inlinePost);
app.route("/extra", inline);
app.route("/books", books);

export const chained = new Hono().basePath("/v2").get("/one", one).post("/two", two);

const docs = new OpenAPIHono();
const getStatus = createRoute({ method: "get", path: "/status/{name}" });
docs.openapi(getStatus, statusHandler);
docs.openapi(createRoute({ method: "post", path: "/status" }), createStatus);
app.route("/meta", docs);

app.all("/hooks", allHooks);

export default app;

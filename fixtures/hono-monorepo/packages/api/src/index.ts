import { Hono } from "hono";
import { billing } from "@acme/billing";
import { catalog } from "@shop/catalog";
import { docs } from "@shop/openapi";
import { users } from "./public";

const app = new Hono().basePath("/v1");

app.route("/users", users);
app.route("/catalog", catalog);
app.route("/billing", billing);
app.route("/docs", docs);

export default app;

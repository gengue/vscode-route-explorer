import { Hono } from "hono";

const app = new Hono();
app.get("/from-dist", function fromDist() {});
export default app;

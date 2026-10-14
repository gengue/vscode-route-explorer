import Fastify from "fastify";
import userRoutes from "./users.js";

const app = Fastify();

export function health(): void {}
export function listItems(): void {}
export function updateItem(): void {}

app.get("/health", health);
app.register(userRoutes, { prefix: "/users" });
app.route({ method: "GET", url: "/items", handler: listItems });
app.route({ method: ["PUT", "PATCH"], url: "/items/:id", handler: updateItem });

export default app;

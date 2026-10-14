import { Hono } from "hono";
import { items, login, privateApp, users, utils } from "./routes";

const app = new Hono();

app.route("/items", items);
app.route("/login", login);
app.route("/private", privateApp);
app.route("/users", users);
app.route("/utils", utils);

export default app;

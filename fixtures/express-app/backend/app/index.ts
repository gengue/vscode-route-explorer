import express from "express";
import { itemsRouter, loginRouter, privateRouter, usersRouter, utilsRouter } from "./routes";

const app = express();

app.use("/items", itemsRouter);
app.use("/login", loginRouter);
app.use("/private", privateRouter);
app.use("/users", usersRouter);
app.use("/utils", utilsRouter);

export default app;

import express, { Router } from "express";

const app = express();
const shared = Router();

function handler(): void {}

shared.get("/x", handler);
app.use("/a", shared);
app.use("/b", shared);

export default app;

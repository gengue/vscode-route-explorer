import { Hono } from "hono";

export const privateApp = new Hono();

export function getPrivate(): void {}

privateApp.get("/", getPrivate);

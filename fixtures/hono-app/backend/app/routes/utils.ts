import { Hono } from "hono";

export const utils = new Hono();

export function health(): void {}
export function version(): void {}

utils.get("/health", health);
utils.get("/version", version);

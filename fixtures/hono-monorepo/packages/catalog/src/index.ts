import { Hono } from "hono";

export const catalog = new Hono();

export function listProducts(): void {}
export function getProduct(): void {}

catalog.get("/", listProducts);
catalog.get("/:sku", getProduct);

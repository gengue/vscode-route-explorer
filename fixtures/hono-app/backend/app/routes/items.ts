import { Hono } from "hono";

export const items = new Hono();

/** List items. */
export function listItems(): void {}

export function getItem(): void {}
export function createItem(): void {}
export function updateItem(): void {}
export function deleteItem(): void {}

items.get("/", listItems);
items.get("/:id", getItem);
items.post("/", createItem);
items.put("/:id", updateItem);
items.delete("/:id", deleteItem);

import { Router } from "express";

export const itemsRouter = Router();

/** List items. */
export function listItems(): void {}

export function getItem(): void {}
export function createItem(): void {}
export function updateItem(): void {}
export function deleteItem(): void {}

itemsRouter.get("/", listItems);
itemsRouter.get("/:id", getItem);
itemsRouter.post("/", createItem);
itemsRouter.put("/:id", updateItem);
itemsRouter.delete("/:id", deleteItem);

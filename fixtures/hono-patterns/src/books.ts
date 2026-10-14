import { Hono } from "hono";

export const books = new Hono();

export function listBooks(): void {}
export function getBook(): void {}
export function createBook(): void {}
export function removeBook(): void {}
export function updateBook(): void {}

books.get("/", listBooks);
books.get("/:id", getBook);
books.post("/", createBook);
books.on("DELETE", "/:id", removeBook);
books.on(["PUT", "PATCH"], "/:id", updateBook);

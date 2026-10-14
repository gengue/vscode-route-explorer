import { Hono } from "hono";

export const comments = new Hono();

export function listComments(): void {}
export function getComment(): void {}

comments.get("/", listComments);
comments.get("/:commentId", getComment);

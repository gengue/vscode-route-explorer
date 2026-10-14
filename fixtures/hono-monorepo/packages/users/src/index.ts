import { Hono } from "hono";
import { posts } from "./posts";

export const users = new Hono();

export function listUsers(): void {}
export function getUser(): void {}

users.get("/", listUsers);
users.get("/:id", getUser);
users.route("/:id/posts", posts);

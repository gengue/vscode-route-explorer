import { Hono } from "hono";
import { comments } from "./comments";

export const posts = new Hono();

export function listPosts(): void {}
export function getPost(): void {}

posts.get("/", listPosts);
posts.get("/:postId", getPost);
posts.route("/:postId/comments", comments);

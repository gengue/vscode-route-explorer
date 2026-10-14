import { Hono } from "hono";

export const users = new Hono();

export function listUsers(): void {}
export function getUser(): void {}
export function createUser(): void {}
export function updateUser(): void {}
export function patchUser(): void {}
export function deleteUser(): void {}
export function listPosts(): void {}
export function createPost(): void {}
export function listFriends(): void {}
export function deleteFriend(): void {}

users.get("/", listUsers);
users.get("/:id", getUser);
users.post("/", createUser);
users.put("/:id", updateUser);
users.patch("/:id", patchUser);
users.delete("/:id", deleteUser);
users.get("/:id/posts", listPosts);
users.post("/:id/posts", createPost);
users.get("/:id/friends", listFriends);
users.delete("/:id/friends/:friendId", deleteFriend);

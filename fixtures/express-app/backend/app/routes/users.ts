import { Router } from "express";

export const usersRouter = Router();

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

usersRouter.get("/", listUsers);
usersRouter.get("/:id", getUser);
usersRouter.post("/", createUser);
usersRouter.put("/:id", updateUser);
usersRouter.patch("/:id", patchUser);
usersRouter.delete("/:id", deleteUser);
usersRouter.get("/:id/posts", listPosts);
usersRouter.post("/:id/posts", createPost);
usersRouter.get("/:id/friends", listFriends);
usersRouter.delete("/:id/friends/:friendId", deleteFriend);

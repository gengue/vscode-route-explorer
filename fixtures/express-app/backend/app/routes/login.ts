import { Router } from "express";

export const loginRouter = Router();

export function showLogin(): void {}
export function submitLogin(): void {}
export function logout(): void {}
export function getSession(): void {}
export function refreshSession(): void {}

loginRouter.get("/", showLogin);
loginRouter.post("/", submitLogin);
loginRouter.post("/logout", logout);
loginRouter.get("/session", getSession);
loginRouter.post("/refresh", refreshSession);

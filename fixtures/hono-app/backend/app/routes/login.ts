import { Hono } from "hono";

export const login = new Hono();

export function showLogin(): void {}
export function submitLogin(): void {}
export function logout(): void {}
export function getSession(): void {}
export function refreshSession(): void {}

login.get("/", showLogin);
login.post("/", submitLogin);
login.post("/logout", logout);
login.get("/session", getSession);
login.post("/refresh", refreshSession);

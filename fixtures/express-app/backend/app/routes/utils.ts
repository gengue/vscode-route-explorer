import { Router } from "express";

export const utilsRouter = Router();

export function health(): void {}
export function version(): void {}

utilsRouter.get("/health", health);
utilsRouter.get("/version", version);

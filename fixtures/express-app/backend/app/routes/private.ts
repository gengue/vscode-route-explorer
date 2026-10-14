import { Router } from "express";

export const privateRouter = Router();

export function getPrivate(): void {}

privateRouter.get("/", getPrivate);

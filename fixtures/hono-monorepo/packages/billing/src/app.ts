import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Hono } from "hono";

export const billing = new Hono();

export function listInvoices(): void {}
export function createInvoice(): void {}
export function getInvoiceHandler(): void {}

billing.get("/invoices", listInvoices);
billing.post("/invoices", createInvoice);

export const getInvoice = createRoute({
  method: "get",
  path: "/invoices/{id}",
});

const publicApi = new OpenAPIHono();
publicApi.openapi(getInvoice, getInvoiceHandler);
billing.route("/public", publicApi);

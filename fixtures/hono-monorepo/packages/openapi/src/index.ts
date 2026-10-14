import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

const getPage = createRoute({ method: "get", path: "/pages/{slug}" });

export const docs = new OpenAPIHono();

export function readPage(): void {}
export function writePage(): void {}

docs.openapi(getPage, readPage);
docs.openapi(createRoute({ method: "put", path: "/pages/{slug}" }), writePage);

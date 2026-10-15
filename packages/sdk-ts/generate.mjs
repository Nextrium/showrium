// Regenerates src/schema.d.ts from the OpenAPI document (OPENAPI_URL, default: local dev server).
import { execFileSync } from "node:child_process";

const url = process.env.OPENAPI_URL ?? "http://localhost:5173/api/v1/openapi.json";
execFileSync(process.platform === "win32" ? "openapi-typescript.cmd" : "openapi-typescript", [url, "-o", "src/schema.d.ts"], { stdio: "inherit", shell: process.platform === "win32" });

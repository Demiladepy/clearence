/**
 * Vercel function: POST /api/onboard. Set the secrets as Vercel environment
 * variables (server-only, never VITE_*): CLR_ADMIN_SECRET,
 * CLR_NG_OPERATOR_SECRET, CLR_GH_OPERATOR_SECRET, CLR_ALLOWED_ORIGINS.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../src/http.js";

export const config = { maxDuration: 60 };

export default function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  return handle(req, res);
}

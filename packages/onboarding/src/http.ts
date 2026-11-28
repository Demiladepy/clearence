/** HTTP handling shared by the local server and the Vercel function. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { OnboardError, configFromEnv, onboard, rateLimiter, type OnboardConfig } from "./onboard.js";

const perIp = rateLimiter(Number(process.env.CLR_RATE_PER_HOUR ?? 5), 60 * 60_000);
let cfg: OnboardConfig | null = null;

function send(res: ServerResponse, status: number, body: unknown, origin: string) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body; // Vercel parses it
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new OnboardError(413, "TOO_LARGE", "request too large");
  }
  return JSON.parse(raw || "{}");
}

export async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  const allowed = (process.env.CLR_ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
  const reqOrigin = String(req.headers.origin ?? "");
  const origin = allowed.includes("*") ? "*" : allowed.includes(reqOrigin) ? reqOrigin : allowed[0]!;
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  if (req.method !== "POST") return send(res, 405, { error: "METHOD_NOT_ALLOWED" }, origin);
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim();
  if (!perIp(ip)) return send(res, 429, { error: "RATE_LIMITED", message: "too many onboardings from this address, try later" }, origin);
  try {
    cfg ??= configFromEnv();
    const out = await onboard(await readJson(req), cfg);
    console.log(JSON.stringify({ at: new Date().toISOString(), ok: true, ...out }));
    return send(res, 200, out, origin);
  } catch (e) {
    if (e instanceof OnboardError) return send(res, e.status, { error: e.code, message: e.message }, origin);
    if (e instanceof SyntaxError) return send(res, 400, { error: "BAD_JSON" }, origin);
    console.error(e);
    return send(res, 502, { error: "CHAIN_ERROR", message: "Stellar testnet did not accept the transaction; nothing to undo, try again" }, origin);
  }
}

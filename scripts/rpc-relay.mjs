// Local JSON-RPC relay: stellar CLI -> http://127.0.0.1:8000 -> (session HTTPS proxy) -> testnet RPC.
import http from "node:http";
const UPSTREAM = process.env.UPSTREAM ?? "https://soroban-testnet.stellar.org";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-client-name, x-client-version", "access-control-allow-methods": "POST, GET, OPTIONS" };
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { ...CORS, "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, CORS); res.end(String(e));
  }
});
// Clients go quiet for tens of seconds while proving; keep idle sockets open
// longer than they do, so a reused connection is never one we already closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(8000, "127.0.0.1", () => console.log("relay on 127.0.0.1:8000 ->", UPSTREAM));

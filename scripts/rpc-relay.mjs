// Local JSON-RPC relay: stellar CLI -> http://127.0.0.1:8000 -> (session HTTPS proxy) -> testnet RPC.
import http from "node:http";
const UPSTREAM = process.env.UPSTREAM ?? "https://soroban-testnet.stellar.org";
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502); res.end(String(e));
  }
}).listen(8000, "127.0.0.1", () => console.log("relay on 127.0.0.1:8000 ->", UPSTREAM));

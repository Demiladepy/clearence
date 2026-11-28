// Drive the browser page with Playwright: SDK in Chromium against testnet.
// Writes deployments/sdk-browser-run.json and docs/evidence/sdk-browser-run.png.
import { createRequire } from "node:module";
// The container ships Playwright globally (require-able, not importable).
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "../..");
const root = join(sdk, "../..");
const files = {
  "/": join(here, "index.html"),
  "/app.js": join(here, "dist/app.js"),
  "/clearance_wasm_bg.wasm": join(sdk, "src/wasm/clearance_wasm_bg.wasm"),
  "/artifacts/clearance_tx_2_2.wasm": join(sdk, "artifacts/clearance_tx_2_2.wasm"),
  "/artifacts/clearance_tx_2_2.r1cs": join(sdk, "artifacts/clearance_tx_2_2.r1cs"),
  "/artifacts/clearance_tx_2_2_proving_key.bin": join(sdk, "artifacts/clearance_tx_2_2_proving_key.bin"),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const f = files[req.url.split("?")[0]];
  if (!f || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(8090, "127.0.0.1");

const secret = (a) => execFileSync("stellar", ["keys", "show", a]).toString().trim();
const ngKey = BigInt(JSON.parse(readFileSync(join(root, ".secrets/operator-ng.json"), "utf8")).privateKey).toString();

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://127.0.0.1:8090/");
await page.waitForFunction(() => typeof window.runDemo === "function");
const result = await page.evaluate((cfg) => window.runDemo(cfg), {
  rpcUrl: process.env.CLEARANCE_RPC ?? "https://soroban-testnet.stellar.org",
  secrets: { ada: secret("clr-ada"), kofi: secret("clr-kofi"), ng: secret("clr-ng") },
  ngRecordKey: ngKey,
});
await page.screenshot({ path: join(root, "docs/evidence/sdk-browser-run.png"), fullPage: true });
await browser.close();
server.close();
writeFileSync(join(root, "deployments/sdk-browser-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), ...result }, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
const ok = result.kofiBalanceUsd >= 2 && result.openedByNg?.amountUsd === 2 && result.adaSpentTodayUsd === 2;
if (!ok) { console.error("browser run assertions FAILED"); process.exit(1); }
console.log("browser run OK");

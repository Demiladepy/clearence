/**
 * Local / self-hosted onboarding server.
 *
 *   CLR_ADMIN_SECRET=S... CLR_NG_OPERATOR_SECRET=S... [CLR_GH_OPERATOR_SECRET=S...] \
 *   [CLR_GRANT_USD=100] [CLR_ALLOWED_ORIGINS=https://app.example] [PORT=8787] pnpm start
 *
 * POST / {address, idCommitment, jurisdiction} -> {tier, kycTx, mintTx, grantUsd}
 */
import { createServer } from "node:http";
import { handle } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => void handle(req, res)).listen(port, "127.0.0.1", () => {
  console.log(`onboarding on http://127.0.0.1:${port}`);
});

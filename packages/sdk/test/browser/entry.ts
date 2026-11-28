/**
 * Browser end-to-end page: the SDK in Chromium against Stellar testnet, with
 * in-browser WASM proving. Driven by run.mjs (Playwright).
 */
import {
  ClearanceClient, ClearanceOperator, TESTNET, fetchArtifacts, initCrypto, keypairWallet, newIdentitySecret,
} from "../../src/index.js";

interface Config {
  rpcUrl: string;
  secrets: { ada: string; kofi: string; ng: string };
  ngRecordKey: string;
}

declare global {
  interface Window {
    runDemo: (c: Config) => Promise<unknown>;
    log: (m: string) => void;
  }
}

window.log = (m: string) => {
  const p = document.createElement("div");
  p.textContent = m;
  document.getElementById("log")!.appendChild(p);
};

window.runDemo = async (cfg: Config) => {
  const d = { ...TESTNET, rpcUrl: cfg.rpcUrl };
  await initCrypto("/clearance_wasm_bg.wasm");
  const t0 = performance.now();
  const artifacts = await fetchArtifacts("/artifacts");
  window.log(`artifacts loaded in ${Math.round(performance.now() - t0)} ms (${navigator.userAgent})`);

  const ng = await ClearanceOperator.connect({ wallet: keypairWallet(cfg.secrets.ng), jurisdiction: "NG", recordKey: cfg.ngRecordKey, deployment: d });
  const ada = await ClearanceClient.connect({ wallet: keypairWallet(cfg.secrets.ada), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });
  const kofi = await ClearanceClient.connect({ wallet: keypairWallet(cfg.secrets.kofi), identitySecret: newIdentitySecret(), jurisdiction: "GH", artifacts, deployment: d });

  const steps: Record<string, unknown>[] = [];
  const tier = await ng.issueTier({ idCommitment: ada.idCommitment, tier: 1 });
  steps.push({ step: "NG operator issues Ada tier 1 (browser)", tx: tier.txHash });
  window.log(`tier issued ${tier.txHash}`);

  const progress: string[] = [];
  const dep = await ada.deposit(10, (p) => progress.push(`${p.step}@${Math.round(p.elapsedMs)}`));
  steps.push({ step: "Ada deposits 10 (proved in Chromium)", tx: dep.txHash, explorer: dep.explorerUrl, provingMs: dep.provingMs });
  window.log(`deposit ${dep.txHash} proving ${dep.provingMs} ms`);

  const pay = await ada.send({ to: kofi.clearanceAddress, toJurisdiction: "GH", amountUsd: 2 });
  steps.push({ step: "Ada pays Kofi 2 NG -> GH (proved in Chromium)", tx: pay.txHash, explorer: pay.explorerUrl, provingMs: pay.provingMs });
  window.log(`payment ${pay.txHash} proving ${pay.provingMs} ms`);

  const balance = await kofi.getBalance();
  const budget = await ada.getBudget();
  const rec = (await ng.listRecords()).find((r) => r.txHash === pay.txHash);
  const opened = rec ? await ng.openRecord(rec.recordId) : null;
  window.log(`Kofi balance ${balance.shieldedUsd}; Ada spent today ${budget.spentTodayUsd}; NG opened ${opened?.amountUsd} USD`);
  return {
    userAgent: navigator.userAgent,
    steps,
    progress,
    kofiBalanceUsd: balance.shieldedUsd,
    adaSpentTodayUsd: budget.spentTodayUsd,
    openedByNg: opened,
    adaIdCommitment: ada.idCommitment,
  };
};

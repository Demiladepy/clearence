/**
 * A WalletLike backed by a Stellar secret key, for servers, operator scripts
 * and tests. In the browser use the user's wallet (Freighter, Albedo, ...).
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { WalletLike } from "./types.js";

export function keypairWallet(secret: string): WalletLike {
  const kp = Keypair.fromSecret(secret);
  return {
    async getAddress() {
      return { address: kp.publicKey() };
    },
    async signTransaction(txXdr: string, opts?: { networkPassphrase?: string }) {
      if (!opts?.networkPassphrase) throw new Error("networkPassphrase required");
      const tx = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
      tx.sign(kp);
      return { signedTxXdr: tx.toXDR() };
    },
  };
}

pragma circom 2.2.2;
// Entry point: Clearance payment, 2 inputs / 2 outputs.
// Pool tree 20 levels (as upstream), identity allow-list 10 levels (as upstream ASP), budget tree 20.
include "./clearanceTransaction.circom";

component main {public [
    root, publicAmount, extDataHash, inputNullifier, outputCommitment, nonce,
    identityRoot, budgetRoot, epoch,
    senderJurisdiction, receiverJurisdiction, senderPackHash, receiverPackHash
]} = ClearanceTransaction(2, 2, 20, 10, 20);

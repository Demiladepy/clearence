pragma circom 2.2.2;
include "../../clearance/identity.circom";

// Same depth as the upstream ASP membership tree (policy_tx_2_2_A).
component main {public [identityRoot, jurisdiction]} = ClearanceIdentity(10);

# Clearance: one entry point for building and proving everything works.
# `make verify` is the bar: a change is done when it passes and the evidence
# in docs/evidence/ is regenerated.

UP := upstream/nethermind-spp
EVIDENCE := docs/evidence

.PHONY: help setup sync circuits wasm deploy-testnet testnet-demo sdk-assets test-sdk-testnet test-sdk-browser demo-accounts test-demo-story test-onboarding test-history onboarding-server test test-contracts test-circuits test-e2e test-sdk verify evidence

help:
	@echo "make setup          init the pinned upstream submodule"
	@echo "make circuits       sync + compile all circuits (incl. test circuits)"
	@echo "make test           contract + circuit + SDK tests"
	@echo "make verify         full rebuild + all tests + write docs/evidence/"
	@echo "make test-history   payments past the RPC's 7-day retention via the event archive (testnet)"
	@echo "make wasm           build the four contract WASMs (verifier embeds clearance_tx_2_2's key)"
	@echo "make deploy-testnet wasm + deploy everything to testnet (scripts/deploy-testnet.py)"

setup:
	git submodule update --init $(UP)

sync:
	./scripts/sync-upstream.sh

circuits: sync
	$(MAKE) -C $(UP) circuits TESTS=1

test-contracts: sync
	cd $(UP) && cargo test -p rule-registry -p clearance-pool
	cd $(UP) && cargo clippy -p rule-registry -p clearance-pool --tests -- -D warnings

wasm: sync
	cd $(UP) && stellar contract build --package rule-registry
	cd $(UP) && stellar contract build --package asp-membership
	cd $(UP) && stellar contract build --package clearance-pool
	cd $(UP) && VERIFIER_VK_JSON=$(CURDIR)/$(UP)/testdata/clearance_tx_2_2_vk.json \
		stellar contract build --package circom-groth16-verifier

deploy-testnet: wasm
	python3 scripts/deploy-testnet.py

# Circuit tests marked #[ignore] need compiled artifacts; `make circuits` first.
test-circuits: sync
	cd $(UP) && cargo test -p circuits --release clearance_ -- --include-ignored

# Real proofs against the real contracts. The verifier embeds the payment
# circuit's key; proofs use the matching proving key from `make circuits`.
test-e2e: sync
	cd $(UP) && VERIFIER_VK_JSON=$(CURDIR)/$(UP)/testdata/clearance_tx_2_2_vk.json \
		cargo test -p clearance-e2e --release -- --include-ignored --skip testnet_demo

# Real payments on Stellar testnet against deployments/testnet.json (needs a
# fresh pool from `make deploy-testnet`). Writes deployments/testnet-demo.json.
testnet-demo: sync
	cd $(UP) && CLEARANCE_TESTNET=1 VERIFIER_VK_JSON=$(CURDIR)/$(UP)/testdata/clearance_tx_2_2_vk.json \
		cargo test -p clearance-e2e --release testnet_demo -- --include-ignored --nocapture

test-sdk:
	pnpm -C packages/sdk typecheck
	pnpm -C packages/sdk build
	pnpm -C packages/onboarding typecheck

# Rebuild the SDK's WASM module, witness calculator and circuit artifacts.
sdk-assets: circuits
	./scripts/build-sdk-assets.sh

# The SDK against Stellar testnet: Node (payer + operator flows, a brand-new
# user), then headless Chromium with in-browser proving. Needs the CLI
# identities and .secrets/ (see docs/sdk.md); in this container, the relay.
test-sdk-testnet:
	cd packages/sdk && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} pnpm test:testnet

test-demo-story:
	cd packages/sdk && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} npx tsx --test test/demo-story.test.ts

test-history:
	cd packages/sdk && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} npx tsx --test test/history.test.ts

test-onboarding:
	cd packages/sdk && pnpm build >/dev/null
	cd packages/onboarding && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} pnpm test:testnet

onboarding-server:
	cd packages/sdk && pnpm build >/dev/null
	cd packages/onboarding && CLR_ADMIN_SECRET=$$(stellar keys show clr-admin) CLR_NG_OPERATOR_SECRET=$$(stellar keys show clr-ng) CLR_GH_OPERATOR_SECRET=$$(stellar keys show clr-gh) pnpm start

demo-accounts:
	cd packages/sdk && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} npx tsx test/provision-demo.ts

test-sdk-browser:
	cd packages/sdk && CLEARANCE_RPC=$${CLEARANCE_RPC:-https://soroban-testnet.stellar.org} pnpm test:browser

test: test-contracts test-circuits test-e2e test-sdk

verify: circuits
	@mkdir -p $(EVIDENCE)
	$(MAKE) test 2>&1 | tee $(EVIDENCE)/test-run.log
	./scripts/write-evidence.sh

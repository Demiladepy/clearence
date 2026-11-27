# Clearance: one entry point for building and proving everything works.
# `make verify` is the bar: a change is done when it passes and the evidence
# in docs/evidence/ is regenerated.

UP := upstream/nethermind-spp
EVIDENCE := docs/evidence

.PHONY: help setup sync circuits wasm deploy-testnet test test-contracts test-circuits test-e2e test-sdk verify evidence

help:
	@echo "make setup          init the pinned upstream submodule"
	@echo "make circuits       sync + compile all circuits (incl. test circuits)"
	@echo "make test           contract + circuit + SDK tests"
	@echo "make verify         full rebuild + all tests + write docs/evidence/"
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
		cargo test -p clearance-e2e --release -- --include-ignored

test-sdk:
	pnpm -C packages/sdk typecheck

test: test-contracts test-circuits test-e2e test-sdk

verify: circuits
	@mkdir -p $(EVIDENCE)
	$(MAKE) test 2>&1 | tee $(EVIDENCE)/test-run.log
	./scripts/write-evidence.sh

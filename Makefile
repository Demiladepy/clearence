# Clearance: one entry point for building and proving everything works.
# `make verify` is the bar: a change is done when it passes and the evidence
# in docs/evidence/ is regenerated.

UP := upstream/nethermind-spp
EVIDENCE := docs/evidence

.PHONY: help setup sync circuits test test-contracts test-circuits test-sdk verify evidence

help:
	@echo "make setup          init the pinned upstream submodule"
	@echo "make circuits       sync + compile all circuits (incl. test circuits)"
	@echo "make test           contract + circuit + SDK tests"
	@echo "make verify         full rebuild + all tests + write docs/evidence/"

setup:
	git submodule update --init $(UP)

sync:
	./scripts/sync-upstream.sh

circuits: sync
	$(MAKE) -C $(UP) circuits TESTS=1

test-contracts: sync
	cd $(UP) && cargo test -p rule-registry
	cd $(UP) && cargo clippy -p rule-registry --tests -- -D warnings

# Circuit tests marked #[ignore] need compiled artifacts; `make circuits` first.
test-circuits: sync
	cd $(UP) && cargo test -p circuits --release clearance_ -- --include-ignored

test-sdk:
	pnpm -C packages/sdk typecheck

test: test-contracts test-circuits test-sdk

verify: circuits
	@mkdir -p $(EVIDENCE)
	$(MAKE) test 2>&1 | tee $(EVIDENCE)/test-run.log
	./scripts/write-evidence.sh

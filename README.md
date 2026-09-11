# Lunarveil — Codex Engineering Handoff

**Project:** Lunarveil
**Target:** AKINDO × Midnight Buildathon 2026
**Architecture baseline:** 2026-08-26
**Status:** Architecture locked for implementation spikes; no production claims yet.

> **Lunarveil is a verifiably fair private batch exchange on Midnight. Traders keep order price, size and strategy off the public ledger; a deterministic batch matcher computes the outcome; Compact verifies that the frozen order set was cleared according to published rules; Zswap is used for private atomic asset settlement.**

This folder is the implementation contract for Codex. Start with `IMPLEMENTATION_START_HERE.md`, then obey `AGENTS.md`.

## What makes Lunarveil different

A normal public DEX is transparent but leaks order flow. A traditional dark pool hides order flow but asks users to trust the operator's matching. Lunarveil aims to combine:

1. **Pre-trade privacy** — raw order side, limit price, size and strategy are not published on-chain.
2. **Frozen order-set integrity** — the accepted order set is committed before matching.
3. **Deterministic frequent-batch clearing** — no discretionary operator priority.
4. **Verifiable execution** — Compact verifies the batch solution against the committed order set.
5. **Private atomic settlement** — Zswap / Midnight wallet intent primitives are the settlement base; no custom custody escrow for the main path.
6. **Auditability without universal disclosure** — users can export an audit bundle proving order inclusion, rules and settlement.

## V1 trust statement

V1 is **private against the public chain and ordinary observers, but not against the single matcher**. The matcher decrypts orders in controlled memory to compute the batch. The matcher cannot change the published matching rule without failing verification. A later threshold/MPC matcher removes this confidentiality trust boundary.

Never market V1 as “the matcher cannot see orders.”

## Repository package map

- `docs/00_research.md` — benchmark research and source-backed lessons.
- `docs/01_protocol_decisions.md` — locked ADR-style product/protocol decisions.
- `docs/02_threat_model.md` — assets, actors, threats, mitigations, residual risks.
- `docs/03_architecture.md` — full system architecture and trust boundaries.
- `docs/04_midnight_integration.md` — pinned Midnight stack and integration rules.
- `docs/05_contract_spec.md` — Compact contract state/circuit specification.
- `docs/06_matching_engine.md` — deterministic FBA algorithm and invariants.
- `docs/07_api_spec.md` — REST/WebSocket behavior and idempotency.
- `docs/08_data_model.md` — database/storage model; ciphertext-only order storage.
- `docs/09_failure_modes.md` — failure matrix and recovery semantics.
- `docs/10_test_strategy.md` — unit/property/contract/integration/privacy/chaos testing.
- `docs/11_repo_structure.md` — target monorepo structure.
- `docs/12_implementation_plan.md` — phase-by-phase Codex execution plan.
- `docs/13_privacy_data_classification.md` — what may and may not be exposed.
- `docs/14_operations_security.md` — key/prover/logging/deployment operational controls.
- `config/midnight-compatibility.yaml` — version and endpoint lock.
- `openapi/lunarveil.openapi.yaml` — initial public API contract.
- `schemas/*.json` — wire schemas for private intent/envelope/batch.
- `packages/matching-core/src/clearBatch.ts` — executable deterministic reference matcher.
- `packages/matching-core/src/canonical.ts` — canonical bigint transport and solution hashing.
- `packages/db/` — ciphertext-only PostgreSQL envelope repository and Prisma schema/migration material.
- `packages/api/` — injected Fastify boundary for session, encrypted-order, optional encrypted-allocation and ciphertext-only firm-up routes; no live listener/configuration.
- `contracts/*/*.compact.pseudocode` — Compact-oriented specs; compile before converting to real contract code.
- `AGENTS.md` — non-negotiable instructions for Codex.

## Immediate build goal

The first end-to-end milestone is deliberately narrow:

```text
2–8 wallets
   ↓
private LIMIT intents
   ↓
commitments included in frozen epoch root
   ↓
deterministic batch clearing
   ↓
Compact proof rejects malicious/incorrect solution
   ↓
matched users firm-up exact settlement
   ↓
Zswap-backed atomic exchange on local Midnight
```

Only after that works do we expand to 16/32 orders, Preprod, midpoint peg, compliance credentials, multi-matcher or MPC.

## Verified baseline and current Docker-free workflow

Milestone 0 previously verified the complete hello-world flow with a disposable Docker node/indexer/proof-server stack. That result remains reproducibility evidence, but Docker is not part of the active M2 workflow. Exact versions, evidence, deviations, and the next implementation boundary are recorded in `docs/implementation-status.md`.

TypeScript runs directly on Windows. Compact compilation is routed through Ubuntu 24.04 on WSL and does not use Docker.

```powershell
npm install
npm run midnight:compile
npm run midnight:typecheck
npm run midnight:m2
npm run midnight:proof-server:install
```

Start the local proof server in one PowerShell window, then generate the real M2 fixture proofs in another:

```powershell
npm run midnight:proof-server:start
# second window
npm run midnight:m2-proofs
```

This rootless WSL workflow downloads the pinned official `midnightntwrk/proof-server:8.1.0` image layer, verifies its immutable digest, and executes its binary directly. It does not install or start Docker. Stop the foreground server with `Ctrl+C`. The official Midnight documentation describes Docker as the supported distribution path, so this direct extraction is a controlled local-development deviation recorded in [ADR-0005](adr/ADR-0005-rootless-wsl-proof-server.md), not a production deployment recommendation.

The old disposable local-chain commands remain available only when Docker is deliberately re-enabled. They are not required for unit tests, canonical commitment vectors, Compact compilation, generated circuit state-transition checks, or local M2 proof generation.

Actual Preprod transactions still require funded wallets plus public node/indexer access. Public node access alone does not generate proofs; the controlled WSL process now supplies proofs locally, so Lunarveil does not send private witnesses to an untrusted public prover.

The typed two-wallet M2 checkpoint is ready for Preview. Inject two distinct test-only seeds and the encrypted private-state password through the runtime environment or a secret manager; never place them in repository files:

```powershell
npm run midnight:m2-chain:typecheck
npm run midnight:m2-chain -- --network preview
```

The command prints faucet addresses when either wallet is unfunded, records only named public deployment metadata, and can be rerun after funding. See [ADR-0006](adr/ADR-0006-m2-two-wallet-chain-checkpoint.md) for its idempotency and privacy boundary.

The M3 N=4 successor has a separate, one-wallet deployment checkpoint. It does
not alter the deployed M2 contract, does not submit an order, and remains
undeployed until this explicit operator action succeeds. First compile and
check the generated contract interface plus public-metadata privacy boundary:

```powershell
npm run midnight:m3-chain:typecheck
npm --prefix spikes/midnight-smoke run check:m3-public-state
```

With the controlled proof server running, inject a funded test-only deployer
seed as `LUNARVEIL_M3_DEPLOYER_SEED` and `PRIVATE_STATE_PASSWORD` through the
current shell or secret manager, then deliberately choose the network:

```powershell
npm run midnight:m3-chain -- --network preview
```

The checkpoint is idempotent only after its public deployment record exists.
An uncertain deployment outcome stops without retry; reconcile the public chain
before running it again. See [ADR-0010](adr/ADR-0010-frontend-freeze-backend-reopen-m3.md).

For the historical M0 local-chain reproduction only:

```powershell
Set-Location spikes\midnight-smoke
npm run setup
npm run test:e2e
```

Before wallet commands, inject `MIDNIGHT_WALLET_SEED` and
`PRIVATE_STATE_PASSWORD` through the current shell or a secret manager. Values
must never be placed in the repository; the smoke tooling does not persist
wallet seeds or serialized private wallet state.

When deliberately enabled, the Docker services use loopback-only ports `127.0.0.1:9944` (node), `127.0.0.1:8088` (indexer), and `127.0.0.1:6300` (proof server). They are historical local-development infrastructure, not production services.

# Lunarveil

A private batch exchange prototype on Midnight. Traders encrypt limit orders;
a deterministic matcher computes a clearing solution, and bounded Compact
circuits check the frozen order set and allocation rules.

**Development preview:** the full live order-to-settlement flow is incomplete.
V1 hides order details from the public chain, but the matcher decrypts orders
in memory. Do not use this prototype with real funds.

## Repository

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Moon landing experience and markets UI |
| `apps/api-server` | API process, wallet sessions and encrypted order intake |
| `apps/admission-worker` | Durable admission-submission worker |
| `apps/reconciler` | Indexer observations and admission reconciliation |
| `apps/matcher` | Epoch-close scheduler |
| `packages/matching-core` | Pure bigint batch matching and adversarial/property tests |
| `packages/crypto` | Commitments and encrypted order/allocation envelopes |
| `packages/db` | PostgreSQL repositories, Prisma schema and migrations |
| `packages/matcher` | Lifecycle services and in-memory batch preparation |
| `packages/api`, `packages/api-client` | HTTP boundary and typed browser client |
| `packages/chain`, `packages/midnight`, `packages/wallet-auth` | Chain and wallet adapters |
| `packages/settlement` | Typed pairwise intent adapter and tests |
| `spikes/midnight-smoke` | Isolated Compact contracts, compiler/proof checks and chain experiments |
| `schemas`, `openapi`, `config` | Wire contracts and pinned Midnight compatibility |

## Quick start

Requires Node.js 22+ and npm. Install the locked dependencies from the root:

```sh
npm ci
npm run typecheck
npm test
npm --workspace @lunarveil/web run dev
```

The landing page does not require a database or wallet. The markets view
requires the API, whose default browser origin is configured below.
No local hosting metadata is required to build the frontend.

```sh
npm --workspace @lunarveil/web run build
```

## API and database

Use a dedicated PostgreSQL 16 development database. Inject runtime variables
through your shell or secret manager; `.env.example` lists the relevant names.
The processes do not automatically load an environment file.

Set `DATABASE_URL` for Prisma and `LUNARVEIL_DATABASE_URL` for the application
to the same database. Apply the checked-in migrations:

```sh
npm exec -- prisma migrate deploy --schema packages/db/prisma/schema.prisma
npm --workspace @lunarveil/api-server run start
```

The API requires `LUNARVEIL_TRADER_TAG_KEY` (at least 32 random bytes as hex).
The optional `LUNARVEIL_DEV_MATCHER_KEY_SEED` is a 32-byte hex seed shared
between development processes. Keep it stable while existing envelopes need
decryption. Production key management is not implemented.

There is no automatic market seed or chain deployment. A blank database
returns an empty catalog. Configure actual deployment data deliberately.

## Verification

`npm test` runs workspace tests, including deterministic matching properties,
privacy boundaries, authentication and failure cases. Database and live-chain
tests are opt-in and skip without explicit configuration.

On Windows with Ubuntu 24.04 WSL and PostgreSQL 16 binaries installed:

```sh
npm --workspace @lunarveil/db run test:integration:wsl
```

This creates and removes an isolated disposable database. It does not test
against a production database.

Midnight experiments have a separate lockfile and compiler requirements.
Use the versions in `config/midnight-compatibility.yaml`; do not install
unqualified latest versions.

```sh
npm --prefix spikes/midnight-smoke ci
npm run midnight:m2
npm run midnight:m3
```

Compact compilation uses the pinned compiler through WSL on Windows.
The historical M3a source/build remains separate from deadline-protected M3b.
`npm run midnight:m3` compiles and checks M3b; the existing M3 chain checkpoint
still targets M3a. M3b has not been deployed and is not a live-contract upgrade.
Real proofs require a controlled proof server. Chain commands require explicit
network configuration and funded test-wallet secrets. Never send private
witnesses to an untrusted prover.

## Implementation boundaries

- Encrypted intake, wallet authentication, admission adapters and deterministic
  matching have automated tests.
- Closed-epoch preparation remains an unscheduled service. It requires frozen
  root evidence; a database-only close cannot safely start matching.
- The deployed proof design is bounded to four orders, LIMIT/GFE, partial
  fills and no minimum fill, reference-price tie-break or cancellation support.
  Broader matching-core capabilities are not claims about that circuit.
- The complete chain-close/proof/allocation/firm-up/settlement orchestration
  and production KMS are incomplete.
- A canonical off-chain solution fingerprint is not a Compact solution
  commitment. Proof-pending database records are workflow state, not chain proof.
- Connector settlement is not atomically coupled to the exchange contract.

## Deployment previews

The repository includes two deployment entry points:

- `vercel.json` builds the web app through Vinext's Nitro Vercel preset. In
  Vercel, keep the project root at the repository root, use Node 22, and set
  `LUNARVEIL_API_BASE_URL` to the HTTPS Render API URL.
- `render.yaml` declares a Node-rendered web preview and an API preview. The
  API requires `LUNARVEIL_DATABASE_URL`, a stable hexadecimal
  `LUNARVEIL_TRADER_TAG_KEY`, and the final Vercel/Render web URL in
  `LUNARVEIL_ALLOWED_ORIGINS`. These secret values are deliberately marked
  manual in the Blueprint.

The Render API preview uses development-only key handling and reports missing
chain/prover/KMS dependencies as unavailable. It is useful for UI/API review;
it is not a production exchange deployment.

## Repository hygiene

This review snapshot excludes planning documents, agent files, wallet stores,
local network state, compiled contract output, build caches and original GLB
source duplicates. Optimized models used by the frontend remain included.
Tests, migrations and lockfiles are retained for reproducibility.

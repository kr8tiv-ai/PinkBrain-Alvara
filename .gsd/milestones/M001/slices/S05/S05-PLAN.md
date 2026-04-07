# S05: Fund Backend & Data Model

**Goal:** PostgreSQL-backed fund data model with Drizzle ORM — full CRUD, state machine, immutability enforcement, and integration with all S01–S04 subsystem types
**Demo:** After this: PostgreSQL-backed service persisting fund instances with full state tracking, connected to all subsystem modules

## Tasks
- [x] **T01: Created PostgreSQL Docker Compose service, Drizzle ORM connection factory, and complete fund data model schema (5 tables, 4 enums) — all type-checking with zero test regressions** — ## Description

Establish the PostgreSQL infrastructure and define the complete fund data model schema. This is the foundation that everything else in S05 builds on.

The project has no database layer yet. We need: Docker Compose for local PostgreSQL, Drizzle ORM + pg driver installed, the connection factory, drizzle-kit config, and the full schema (5 tables + 3 enums).

## Steps

1. Create `docker-compose.yml` with PostgreSQL 16 service: port 5432, `pinkbrain` database, `pinkbrain` user, password `pinkbrain_dev`, named volume for data persistence, health check (`pg_isready`).

2. Install dependencies: `npm install drizzle-orm pg` and `npm install -D drizzle-kit @types/pg`.

3. Create `src/db/connection.ts`:
   - Import `drizzle` from `drizzle-orm/node-postgres` and `Pool` from `pg`
   - Export `createDb()` function that reads `DATABASE_URL` env var (default: `postgresql://pinkbrain:pinkbrain_dev@localhost:5432/pinkbrain`), creates a `Pool`, and returns `drizzle({ client: pool })`
   - Export the pool separately for shutdown cleanup
   - Follow the config encapsulation pattern from `src/config/chains.ts`

4. Create `drizzle.config.ts` at project root:
   - `dialect: 'postgresql'`
   - `schema: './src/db/schema.ts'`
   - `out: './drizzle'` (for migration files)
   - `dbCredentials.url` from `DATABASE_URL` env var with same default

5. Create `src/db/schema.ts` with the full schema:

   **Enums:**
   - `fundStatusEnum`: `pgEnum('fund_status', ['created', 'configuring', 'active', 'divesting', 'distributing', 'completed', 'paused', 'failed'])`
   - `chainEnum`: `pgEnum('chain', ['solana', 'base', 'ethereum'])`
   - `pipelinePhaseEnum`: `pgEnum('pipeline_phase', ['claiming', 'swapping', 'bridging', 'investing', 'divesting', 'distributing'])`
   - `operationEnum`: `pgEnum('operation', ['fee_claim', 'swap', 'bridge_send', 'bridge_receive', 'bskt_create', 'bskt_rebalance', 'bskt_redeem', 'distribution'])`

   **Tables:**
   - `funds` — `id` (uuid PK, `.defaultRandom()`), `name` (text, not null), `tokenMint` (text, not null — Bags SPL token), `creatorWallet` (text, not null — Solana pubkey), `status` (fundStatusEnum, not null, default 'created'), `targetChain` (chainEnum, not null), `protocolFeeBps` (integer, not null — basis points), `bsktAddress` (text, nullable — set after BSKT creation), `createdAt` (timestamp, defaultNow), `updatedAt` (timestamp, defaultNow)
   - `fundWallets` — `id` (uuid PK), `fundId` (uuid FK → funds, not null), `chain` (chainEnum, not null), `address` (text, not null), `walletType` (text, not null — 'treasury' | 'operations'), `createdAt` (timestamp, defaultNow)
   - `fundDivestmentConfig` — `id` (uuid PK), `fundId` (uuid FK → funds, unique, not null), `holderSplitBps` (integer, not null), `ownerSplitBps` (integer, not null), `triggerType` (text, not null — 'time' | 'threshold' | 'both'), `triggerParams` (jsonb, not null), `distributionCurrency` (text, not null — 'usdc' | 'sol'), `lockedAt` (timestamp, nullable — null until locked), `createdAt` (timestamp, defaultNow)
   - `pipelineRuns` — `id` (uuid PK), `fundId` (uuid FK → funds, not null), `direction` (text, not null — 'outbound' | 'inbound'), `phase` (pipelinePhaseEnum, not null), `status` (text, not null, default 'pending' — 'pending' | 'running' | 'completed' | 'failed'), `startedAt` (timestamp, nullable), `completedAt` (timestamp, nullable), `error` (text, nullable), `metadata` (jsonb, nullable), `createdAt` (timestamp, defaultNow)
   - `transactions` — `id` (uuid PK), `fundId` (uuid FK → funds, not null), `pipelineRunId` (uuid FK → pipelineRuns, nullable), `chain` (chainEnum, not null), `txHash` (text, not null), `operation` (operationEnum, not null), `amount` (text, not null — atomic units as string for bigint safety), `token` (text, not null — address/mint), `status` (text, not null, default 'pending' — 'pending' | 'confirmed' | 'failed'), `createdAt` (timestamp, defaultNow), `confirmedAt` (timestamp, nullable)

6. Add `DATABASE_URL` to `.env.example` with the local default value.

7. Start Docker PostgreSQL and push the schema:
   - `docker compose up -d`
   - `npx drizzle-kit push`
   - Verify tables exist by running a quick query via the db connection

8. Verify: `npx tsc --noEmit` compiles all new files. Existing 143 tests still pass.

## Must-Haves

- [ ] Docker Compose file with PostgreSQL 16 and health check
- [ ] Drizzle ORM + pg + drizzle-kit installed
- [ ] `src/db/connection.ts` with `createDb()` factory using DATABASE_URL
- [ ] `drizzle.config.ts` at project root
- [ ] `src/db/schema.ts` with all 5 tables and 4 enums
- [ ] Schema pushes to PostgreSQL without errors
- [ ] `npx tsc --noEmit` exits 0
- [ ] Existing tests pass with zero regressions
  - Estimate: 45m
  - Files: docker-compose.yml, drizzle.config.ts, src/db/connection.ts, src/db/schema.ts, .env.example, package.json
  - Verify: npx tsc --noEmit && npx vitest run
- [x] **T02: Built typed fund repository with 15 CRUD functions, state-machine-validated status transitions, R017 divestment config immutability, and structured mutation logging** — ## Description

Build the fund repository module — the typed interface between the application and the database. This is where the business logic lives: fund creation, status transitions with state machine validation, divestment config immutability (R017), wallet assignment, transaction logging, and pipeline run lifecycle.

Also create the domain types file that re-exports Drizzle inferred types and defines additional fund domain interfaces.

## Steps

1. Create `src/db/types.ts`:
   - Re-export Drizzle `$inferSelect` and `$inferInsert` types from each table in schema.ts: `Fund`, `NewFund`, `FundWallet`, `NewFundWallet`, `FundDivestmentConfig`, `NewFundDivestmentConfig`, `PipelineRun`, `NewPipelineRun`, `Transaction`, `NewTransaction`
   - Define `FundStatus` type from the enum values
   - Define a `VALID_STATUS_TRANSITIONS` map: Record<FundStatus, FundStatus[]>:
     - `created` → [`configuring`]
     - `configuring` → [`active`, `failed`]
     - `active` → [`divesting`, `paused`, `failed`]
     - `divesting` → [`distributing`, `failed`]
     - `distributing` → [`completed`, `failed`]
     - `paused` → [`active`, `failed`]
     - `completed` → [] (terminal)
     - `failed` → [`created`] (retry from scratch)
   - Export a `isValidTransition(from, to)` helper

2. Create `src/db/fund-repository.ts` with these exported functions (all accept a `db` parameter — the Drizzle instance from `createDb()`):

   **Fund CRUD:**
   - `createFund(db, input: NewFund): Promise<Fund>` — inserts and returns the created fund
   - `getFundById(db, id: string): Promise<Fund | null>` — select by UUID
   - `listFunds(db, filters?: { status?: FundStatus }): Promise<Fund[]>` — list with optional status filter
   - `updateFundStatus(db, id: string, newStatus: FundStatus): Promise<Fund>` — validates state transition using VALID_STATUS_TRANSITIONS, throws `InvalidStateTransition` error with `{ fundId, currentStatus, requestedStatus }` if invalid. Updates `updatedAt` timestamp.
   - `updateFundBsktAddress(db, id: string, bsktAddress: string): Promise<Fund>` — sets bskt_address after basket creation

   **Wallets:**
   - `setFundWallets(db, fundId: string, wallets: NewFundWallet[]): Promise<FundWallet[]>` — bulk insert wallets for a fund
   - `getFundWallets(db, fundId: string): Promise<FundWallet[]>` — get all wallets for a fund

   **Divestment Config (R017 immutability):**
   - `setDivestmentConfig(db, config: NewFundDivestmentConfig): Promise<FundDivestmentConfig>` — insert config. Validates holderSplitBps + ownerSplitBps <= 10000. If a config already exists for this fund AND `lockedAt` is set, throw `ConfigLocked` error with `{ fundId, lockedAt }`. If config exists but isn't locked, update it.
   - `lockDivestmentConfig(db, fundId: string): Promise<FundDivestmentConfig>` — sets `lockedAt` to now. Throws if already locked.
   - `getDivestmentConfig(db, fundId: string): Promise<FundDivestmentConfig | null>`

   **Pipeline Runs:**
   - `createPipelineRun(db, input: NewPipelineRun): Promise<PipelineRun>` — insert
   - `updatePipelineRun(db, id: string, updates: { status?: string; phase?: string; error?: string; metadata?: unknown; completedAt?: Date }): Promise<PipelineRun>` — partial update
   - `getActivePipelineRuns(db, fundId: string): Promise<PipelineRun[]>` — runs with status 'pending' or 'running'

   **Transactions:**
   - `recordTransaction(db, input: NewTransaction): Promise<Transaction>` — insert
   - `confirmTransaction(db, id: string): Promise<Transaction>` — set status='confirmed', confirmedAt=now
   - `getTransactionsByFund(db, fundId: string): Promise<Transaction[]>` — all transactions for a fund

   All mutations should include structured JSON logging: `{ module: 'db', action: '<functionName>', fundId, ...relevant fields }`

3. Define custom error classes in `src/db/errors.ts`:
   - `InvalidStateTransition extends Error` with `fundId`, `currentStatus`, `requestedStatus` fields
   - `ConfigLocked extends Error` with `fundId`, `lockedAt` fields
   - `FundNotFound extends Error` with `fundId` field

4. Verify: `npx tsc --noEmit` compiles all new files.

## Must-Haves

- [ ] `src/db/types.ts` with inferred types, status transition map, and validation helper
- [ ] `src/db/fund-repository.ts` with all CRUD functions accepting a `db` parameter
- [ ] `src/db/errors.ts` with typed error classes
- [ ] State machine validates transitions — invalid moves throw `InvalidStateTransition`
- [ ] Divestment config immutability — updates after `lockedAt` throw `ConfigLocked` (R017)
- [ ] Basis points validation — holderSplitBps + ownerSplitBps <= 10000
- [ ] All mutations include structured JSON logging
- [ ] `npx tsc --noEmit` exits 0

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| PostgreSQL (via pg pool) | Repository functions propagate DB errors with context (fund_id, operation) | pg pool has built-in connection timeout; propagate as connection error | Drizzle validates column types at insert — type mismatch throws before query |

## Negative Tests

- **Malformed inputs**: empty fund name, negative protocol fee bps, bps > 10000, empty wallet address, missing required fields
- **Error paths**: invalid state transition (active → created), update locked divestment config, get nonexistent fund
- **Boundary conditions**: zero bps splits, bps summing to exactly 10000, fund with no wallets, fund with no divestment config
  - Estimate: 1h
  - Files: src/db/types.ts, src/db/fund-repository.ts, src/db/errors.ts
  - Verify: npx tsc --noEmit
- [x] **T03: Created 27-test integration test suite and db-seed script covering fund CRUD, state machine, R017 immutability, wallets, pipeline runs, and transactions — type-checks clean with zero test regressions** — ## Description

Write comprehensive tests for the fund repository against a real PostgreSQL instance (Docker) and a seed script that proves the entire data model end-to-end. This is the verification task — it proves R001 (fund creation), R016 (protocol fee), and R017 (immutability) actually work.

Tests must run against real PostgreSQL, not mocked Drizzle — the value is proving real SQL execution works correctly.

## Steps

1. Create `tests/fund-repository.test.ts`:
   - Import `createDb` from `src/db/connection.ts`, repository functions from `src/db/fund-repository.ts`, error classes from `src/db/errors.ts`
   - `beforeAll`: create db instance (uses DATABASE_URL env var or default local Docker connection)
   - `beforeEach`: truncate all tables in reverse FK order (transactions → pipelineRuns → fundDivestmentConfig → fundWallets → funds) using `db.delete(table)` for each table
   - `afterAll`: close the pool

   **Test groups:**

   a) **Fund CRUD** (~6 tests):
   - Creates a fund with all required fields and returns it with generated UUID
   - getFundById returns the created fund
   - getFundById returns null for nonexistent UUID
   - listFunds returns all funds
   - listFunds filters by status
   - updateFundBsktAddress sets the bskt_address field

   b) **State machine** (~6 tests):
   - Valid transition: created → configuring succeeds
   - Valid transition chain: created → configuring → active → divesting → distributing → completed
   - Invalid transition: created → active throws InvalidStateTransition
   - Invalid transition: completed → active throws InvalidStateTransition
   - Failed state: active → failed succeeds
   - Retry: failed → created succeeds

   c) **Divestment config & immutability (R017)** (~5 tests):
   - setDivestmentConfig creates config for a fund
   - getDivestmentConfig returns null for fund without config
   - lockDivestmentConfig sets lockedAt timestamp
   - setDivestmentConfig on locked config throws ConfigLocked
   - Basis points validation: holderSplitBps + ownerSplitBps > 10000 throws

   d) **Wallets** (~3 tests):
   - setFundWallets creates wallets for a fund
   - getFundWallets returns all wallets
   - Multiple wallet types (treasury + operations) for same fund

   e) **Pipeline runs** (~4 tests):
   - createPipelineRun creates a run
   - updatePipelineRun updates status and phase
   - updatePipelineRun sets error on failure
   - getActivePipelineRuns returns only pending/running runs

   f) **Transactions** (~3 tests):
   - recordTransaction creates a transaction record
   - confirmTransaction sets status and confirmedAt
   - getTransactionsByFund returns all transactions for a fund

2. Create `scripts/db-seed.ts`:
   - Creates a test fund named 'Test BRAIN Fund' with tokenMint, creatorWallet, targetChain='base', protocolFeeBps=200 (2%)
   - Transitions: created → configuring → active
   - Adds wallets: Solana treasury + Base operations
   - Sets divestment config: 7000 bps holders, 3000 bps owner, trigger='time', params={intervalHours: 24}, currency='usdc'
   - Locks the config
   - Creates a pipeline run (outbound, claiming phase)
   - Records a transaction (fee_claim on solana)
   - Outputs all created records as formatted JSON
   - Exits 0 on success, 1 on failure with error details
   - Add `db-seed` npm script: `tsx scripts/db-seed.ts`

3. Run verification:
   - Ensure Docker PostgreSQL is running
   - `npx drizzle-kit push` to ensure schema is current
   - `npx vitest run tests/fund-repository.test.ts` — all tests pass
   - `npx tsx scripts/db-seed.ts` — outputs JSON, exits 0
   - `npx vitest run` — full suite passes (existing 143 + new fund tests)
   - `npx tsc --noEmit` — zero errors

## Must-Haves

- [ ] `tests/fund-repository.test.ts` with ~27 tests covering all repository functions
- [ ] Tests run against real PostgreSQL (Docker), not mocked
- [ ] Table truncation in beforeEach for test isolation
- [ ] State machine transitions tested (valid + invalid)
- [ ] Immutability enforcement tested (R017)
- [ ] `scripts/db-seed.ts` creates a full test fund with all related records
- [ ] `db-seed` npm script added to package.json
- [ ] Full test suite passes with zero regressions
- [ ] `npx tsc --noEmit` exits 0

## Negative Tests

- **Malformed inputs**: invalid state transitions throw typed errors with context
- **Error paths**: update locked divestment config, get nonexistent fund
- **Boundary conditions**: bps summing to exactly 10000 (valid), bps summing to 10001 (invalid), terminal state (completed) with no valid transitions
  - Estimate: 1h
  - Files: tests/fund-repository.test.ts, scripts/db-seed.ts, package.json
  - Verify: npx vitest run tests/fund-repository.test.ts && npx tsx scripts/db-seed.ts && npx vitest run && npx tsc --noEmit

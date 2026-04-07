# PinkBrain Alvara Fund

## What This Is

A multi-tenant Bags.fm app store application that automates a cross-chain financial pipeline: captures Solana token reflections from Bags.fm fee shares, bridges them to EVM (Base + Ethereum mainnet), invests in Alvara Protocol ERC-7621 basket funds, and upon divestment distributes proceeds back to top 100 token holders. Created by PinkBrain ($BRAIN) but usable by any Bags.fm token creator.

The app takes a protocol fee on reflections as its revenue model. Each token creator gets an isolated fund instance with their own treasury wallet, Alvara basket, and immutable on-chain divestment configuration.

## Core Value

Any Bags.fm token creator can set up a fully automated investment fund that transparently pipes reflections into an EVM basket and auto-divests back to holders — zero manual intervention after setup, fully on-chain verifiable.

## Current State

**M001: Risk Retirement & Subsystem Proof — COMPLETE ✅**

All six critical subsystems proven independently and the outbound pipeline wired end-to-end. 163 passing unit/integration tests across 8 test files, 25 TypeScript source modules, 11 CLI scripts.

**M002: Outbound Pipeline (Solana → Alvara) — IN PROGRESS**

| Slice | Status | Summary |
|---|---|---|
| S01: Alvara Backend API & BSKT Investment | ✅ Complete | Typed API client (4 endpoints), contribute orchestration, CLI with dry-run, 50 tests. |
| S02: Accumulation Scheduler & Automated Pipeline | ✅ Complete | BullMQ scheduler, 5-phase pipeline (claim→swap→fee→bridge→invest), checkpoint crash recovery, 57 new tests (250 total). |
| S03: Rebalancing & Emergency Controls | ⬜ Next | Rebalance + emergency stables using S01's API client |
| S04: On-Chain Divestment Config Registry | ⬜ Pending | Solidity contract + TypeScript client |
| S05: REST API & Fund Management | ⬜ Pending | Fastify REST API wiring all subsystems |

**S02 Delivered:**
- `src/scheduler/` — BullMQ-based accumulation scheduler: Redis connection singleton, queue factory, Worker that polls active funds on cron (default every 6 hours), checks SOL balance against configurable threshold, enforces concurrency guard, dispatches pipeline
- `src/evm/swap.ts` — USDC→ETH swap via 1inch Swap API v6.0 on Base (allowance check, approve, fetch calldata, send, confirm)
- Pipeline phase 5 (investing): swaps bridged USDC to ETH, contributes ETH to Alvara BSKT via S01's contributeToBSKT
- Checkpoint persistence for all 5 pipeline phases with advisory writes and resumeOutboundPipeline() for crash recovery
- `scripts/start-scheduler.ts` — CLI entry point with --cron flag, graceful shutdown
- DB schema: accumulationThresholdLamports, lastPipelineRunAt on funds; bskt_contribute operation enum
- Docker: Redis 7 Alpine service with health check

## Architecture / Key Patterns

**Three-layer architecture:**
- **Solana Operations Layer** — Bags SDK fee share, Jupiter swaps, SPL token distribution, Helius RPC holder resolution
- **Bridge Orchestration Layer (Fund Engine)** — Node.js service coordinating cross-chain state, PostgreSQL + BullMQ, multi-fund state machines
- **EVM Operations Layer** — Alvara factory interaction on Base + Ethereum, viem, ERC-721 basket management, backend-signed swap routes

**Key tech stack:**
- TypeScript (Node.js 18+) for all backend services
- React + Next.js for Bags.fm embedded app UI
- @bagsfm/bags-sdk, @solana/web3.js, Jupiter SDK for Solana
- deBridge DLN REST API for cross-chain bridging (thin client, no SDK)
- viem for EVM interaction (established in M001/S01)
- vitest for unit testing (established in M001/S02)
- Drizzle ORM + node-postgres for fund data persistence (established in M001/S05)
- PostgreSQL 16 + Redis 7 / BullMQ for state and job queues
- Foundry for Solidity contracts

**Key constraints:**
- Alvara BSKTs are ERC-721 NFTs with custom interface (not standard ERC-7621)
- BSKT creation and contribution require Alvara backend-signed swap routes (MEV protection)
- contribute() is on the BSKT NFT contract, not BSKTPair or factory (K014)
- Every BSKT must include ≥5% ALVA token allocation
- Divestment config immutable after fund creation, stored on-chain
- Distribution to top 100 holders by token balance (not a separate staking contract)
- Alvara backend API base URL not yet confirmed — defaults to https://api.alvara.xyz, configurable via ALVARA_API_URL

**Established patterns (M001 + M002/S01-S02):**
- Blockscout free API for Base chain (Etherscan V2 optional fallback with paid key)
- EIP-1967 proxy detection for Alvara contract resolution
- Beacon proxy ABI resolution — factory.*Implementation() → beacon.implementation() → Blockscout verified ABI
- Structured JSON logging with module/phase/action fields
- Thin REST API clients with typed inputs/outputs, runtime response validation (deBridge + Jupiter + Alvara + 1inch patterns)
- SDK wrapper with mock injection — functions accept SDK instance, not raw API key (Bags pattern)
- EVM contribute orchestration — resolve pair → read LP → fetch routes → gas → tx → confirm → verify LP
- Dual-mode CLI scripts: safe estimate/dry-run vs full execution
- vitest with fetch mocking and SDK mock injection for unit tests
- Integration tests skip gracefully when infrastructure unavailable (ctx.skip() pattern)
- Five-phase pipeline orchestration with per-phase checkpoint persistence and crash recovery
- Advisory checkpoint writes — failures logged but never block pipeline
- BullMQ Worker with per-fund error isolation and concurrency guards
- Raw SPL Token instruction building from @solana/web3.js primitives

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Risk Retirement & Subsystem Proof — COMPLETE ✅
- [ ] M002: Outbound Pipeline (Solana → Alvara) — S01-S02 complete, S03-S05 remaining
- [ ] M003: Return Pipeline & Distribution — Auto-divestment triggers liquidation, proceeds bridge back to Solana and distribute to holders
- [ ] M004: App Store Launch — Bags.fm embedded UI, dashboard, notifications, multi-fund parallel operation

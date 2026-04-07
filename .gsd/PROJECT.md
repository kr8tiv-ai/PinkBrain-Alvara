# PinkBrain Alvara Fund

## What This Is

A multi-tenant Bags.fm app store application that automates a cross-chain financial pipeline: captures Solana token reflections from Bags.fm fee shares, bridges them to EVM (Base + Ethereum mainnet), invests in Alvara Protocol ERC-7621 basket funds, and upon divestment distributes proceeds back to top 100 token holders. Created by PinkBrain ($BRAIN) but usable by any Bags.fm token creator.

The app takes a protocol fee on reflections as its revenue model. Each token creator gets an isolated fund instance with their own treasury wallet, Alvara basket, and immutable on-chain divestment configuration.

## Core Value

Any Bags.fm token creator can set up a fully automated investment fund that transparently pipes reflections into an EVM basket and auto-divests back to holders — zero manual intervention after setup, fully on-chain verifiable.

## Current State

**M001: Risk Retirement & Subsystem Proof — COMPLETE ✅**

All six critical subsystems proven independently and the outbound pipeline wired end-to-end. 163 passing unit/integration tests across 8 test files, 25 TypeScript source modules, 11 CLI scripts.

| Subsystem | Module | Proof Level |
|---|---|---|
| Alvara Factory Discovery | src/alvara/ | Factory at 0x9ee08080, full ABI, MEV analysis confirms backend-signed routes required |
| deBridge Solana→Base Bridge | src/debridge/ | Live estimate dry-run, typed DLN client, Solana tx pipeline, 37 tests |
| Bags SDK Fee Share | src/bags/ | SDK wrapper with mock injection, admin/claim functions, 42 tests |
| Jupiter Swap | src/jupiter/ | Live quote 0.01 SOL → 0.80 USDC, 24 tests |
| Holder Resolution | src/holders/ | Dual-strategy (Helius DAS + getProgramAccounts), 40 tests |
| Fund Data Model | src/db/ | Drizzle ORM, 5 tables, 15 CRUD functions, state machine, 28 integration tests |
| Outbound Pipeline | src/pipeline/ | claim→swap→fee→bridge orchestrator with DB state tracking, 20 tests |

**Next: M002 (Outbound Pipeline: Solana → Alvara)** — accumulation scheduler, Alvara backend API integration for BSKT creation, pipeline retry logic.

## Architecture / Key Patterns

**Three-layer architecture:**
- **Solana Operations Layer** — Bags SDK fee share, Jupiter swaps, SPL token distribution, Helius RPC holder resolution
- **Bridge Orchestration Layer (Fund Engine)** — Node.js service coordinating cross-chain state, PostgreSQL + BullMQ, multi-fund state machines
- **EVM Operations Layer** — Alvara factory interaction on Base + Ethereum, viem, ERC-721 basket management

**Key tech stack:**
- TypeScript (Node.js 18+) for all backend services
- React + Next.js for Bags.fm embedded app UI
- @bagsfm/bags-sdk, @solana/web3.js, Jupiter SDK for Solana
- deBridge DLN REST API for cross-chain bridging (thin client, no SDK)
- viem for EVM interaction (established in S01)
- vitest for unit testing (established in S02)
- Drizzle ORM + node-postgres for fund data persistence (established in S05)
- PostgreSQL 16 + Redis/BullMQ for state and job queues
- Foundry for Solidity contracts

**Key constraints:**
- Alvara BSKTs are ERC-721 NFTs with custom interface (not standard ERC-7621)
- BSKT creation requires Alvara backend-signed swap routes (MEV protection)
- Every BSKT must include ≥5% ALVA token allocation
- Divestment config immutable after fund creation, stored on-chain
- Distribution to top 100 holders by token balance (not a separate staking contract)
- Bags SDK rate limit: 1,000 req/hour per API key
- deBridge create-tx is GET with query params; dstChainTokenOutAmount=auto required
- Public Solana RPC rejects getProgramAccounts for high-holder-count tokens — use Helius DAS

**Established patterns (M001):**
- Blockscout free API for Base chain (Etherscan V2 optional fallback with paid key)
- EIP-1967 proxy detection for Alvara contract resolution
- Structured JSON logging with module/phase/action fields
- Thin REST API clients with typed inputs/outputs (deBridge + Jupiter pattern)
- SDK wrapper with mock injection — functions accept SDK instance, not raw API key (Bags pattern)
- Client-side input validation before SDK/API calls
- Dual-mode CLI scripts: safe estimate/dry-run vs full execution
- vitest with fetch mocking and SDK mock injection for unit tests
- Dual-strategy resolution with automatic fallback (Helius DAS → getProgramAccounts)
- Integer math (bigint) for percentage calculation avoiding float drift
- Drizzle ORM db injection: all repository functions accept `db` parameter
- Fund lifecycle state machine: Record<FundStatus, FundStatus[]> with typed error classes
- Integration tests skip gracefully when infrastructure unavailable (ctx.skip() pattern)
- Four-phase pipeline orchestration with per-phase DB state tracking
- Raw SPL Token instruction building from @solana/web3.js primitives
- BigInt arithmetic for all USDC atomic unit calculations

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Risk Retirement & Subsystem Proof — COMPLETE ✅
- [ ] M002: Outbound Pipeline (Solana → Alvara) — Reflections flow automatically from Bags.fm into Alvara baskets
- [ ] M003: Return Pipeline & Distribution — Auto-divestment triggers liquidation, proceeds bridge back to Solana and distribute to holders
- [ ] M004: App Store Launch — Bags.fm embedded UI, dashboard, notifications, multi-fund parallel operation

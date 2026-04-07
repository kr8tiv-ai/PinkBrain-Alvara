# PinkBrain Alvara Fund

## What This Is

A multi-tenant Bags.fm app store application that automates a cross-chain financial pipeline: captures Solana token reflections from Bags.fm fee shares, bridges them to EVM (Base + Ethereum mainnet), invests in Alvara Protocol ERC-7621 basket funds, and upon divestment distributes proceeds back to top 100 token holders. Created by PinkBrain ($BRAIN) but usable by any Bags.fm token creator.

The app takes a protocol fee on reflections as its revenue model. Each token creator gets an isolated fund instance with their own treasury wallet, Alvara basket, and immutable on-chain divestment configuration.

## Core Value

Any Bags.fm token creator can set up a fully automated investment fund that transparently pipes reflections into an EVM basket and auto-divests back to holders — zero manual intervention after setup, fully on-chain verifiable.

## Current State

**M001: S01 ✅, S02 ✅, S03 ✅.** Three of six subsystem proofs complete.

**S01 (Alvara Factory Discovery & BSKT Proof)** delivered:
- Alvara BSKTs are ERC-721 NFTs (not standard ERC-7621) with custom view functions
- BSKT creation requires backend-signed MEV-protected swap routes via 1inch
- Every BSKT must include ≥5% ALVA token allocation (factory-enforced)
- Factory address (`0x9ee08080`) discovered on Base with full 93-entry verified ABI
- Artifacts: discovered-contracts.json, mev-findings.json, factory interaction module, 10-check BSKT verification suite

**S02 (deBridge Solana→Base Bridge Proof)** delivered:
- Typed deBridge DLN REST client wrapping create-tx, order-by-hash, and order-status endpoints
- Solana VersionedTransaction preparation pipeline: deserialization, blockhash refresh, compute budget injection, signing, submission
- Live API proof: estimate-only dry-run returned valid Solana→Base USDC estimation from production endpoint
- 37 unit tests (20 API client, 17 Solana tx) passing with vitest
- CLI scripts for bridging and status checking
- Key discovery: create-tx endpoint uses GET (not POST), requires dstChainTokenOutAmount=auto

**S03 (Bags SDK Fee Share & Reflection Claiming)** delivered:
- Complete Bags SDK integration: client wrapper, fee share admin queries, config updates, fee claiming
- 4 modules: types.ts, client.ts, fee-share.ts, fee-claim.ts with 10 exported functions
- Client-side basis points validation (sum-to-10000) before any SDK call
- CLI proof script with --dry-run mode showing all 6 API response shapes
- 42 unit tests (14 client, 28 fee-share/claim) — all mocked, zero network calls
- Pattern: functions accept SDK instance as first param for mock injection testability

Remaining: S04 (Jupiter/holders) is independent. S05–S06 depend on all prior slices.

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

**Established patterns (S01 + S02 + S03):**
- Blockscout free API for Base chain (Etherscan V2 as optional fallback with paid key)
- EIP-1967 proxy detection for Alvara contract resolution
- Structured JSON logging with module/phase/action fields
- 250ms delays between sequential RPC reads for public endpoint rate limits
- BSKT ABI discovery chain: factory → bsktImplementation (beacon) → implementation → logic ABI
- Thin REST API clients with typed inputs/outputs (no SDK dependencies) — deBridge pattern
- SDK wrapper with mock injection — functions accept SDK instance, not raw API key — Bags pattern
- Client-side input validation before SDK/API calls (basis points sum, wallet format)
- Dual-mode CLI scripts: safe estimate/dry-run vs full execution
- vitest with fetch mocking and SDK mock injection for unit tests

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Risk Retirement & Subsystem Proof — S01 ✅, S02 ✅, S03 ✅, S04–S06 remaining
- [ ] M002: Outbound Pipeline (Solana → Alvara) — Reflections flow automatically from Bags.fm into Alvara baskets
- [ ] M003: Return Pipeline & Distribution — Auto-divestment triggers liquidation, proceeds bridge back to Solana and distribute to holders
- [ ] M004: App Store Launch — Bags.fm embedded UI, dashboard, notifications, multi-fund parallel operation

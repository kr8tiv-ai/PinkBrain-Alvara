# PinkBrain Alvara Fund

## What This Is

A multi-tenant Bags.fm app store application that automates a cross-chain financial pipeline: captures Solana token reflections from Bags.fm fee shares, bridges them to EVM (Base + Ethereum mainnet), invests in Alvara Protocol ERC-7621 basket funds, and upon divestment distributes proceeds back to top 100 token holders. Created by PinkBrain ($BRAIN) but usable by any Bags.fm token creator.

The app takes a protocol fee on reflections as its revenue model. Each token creator gets an isolated fund instance with their own treasury wallet, Alvara basket, and immutable on-chain divestment configuration.

## Core Value

<!-- This is the primary value anchor for prioritization and tradeoffs.
     If scope must shrink, this should survive. -->

Any Bags.fm token creator can set up a fully automated investment fund that transparently pipes reflections into an EVM basket and auto-divests back to holders — zero manual intervention after setup, fully on-chain verifiable.

## Current State

Empty repository. No code exists yet.

## Architecture / Key Patterns

**Three-layer architecture:**
- **Solana Operations Layer** — Bags SDK fee share, Jupiter swaps, SPL token distribution, Helius RPC holder resolution
- **Bridge Orchestration Layer (Fund Engine)** — Node.js service coordinating cross-chain state, PostgreSQL + BullMQ, multi-fund state machines
- **EVM Operations Layer** — Alvara factory interaction on Base + Ethereum, ethers.js v6, ERC-7621 basket management

**Key tech stack:**
- TypeScript (Node.js 18+) for all backend services
- React + Next.js for Bags.fm embedded app UI
- @bagsfm/bags-sdk, @solana/web3.js, Jupiter SDK for Solana
- deBridge DLN REST API for cross-chain bridging
- ethers.js v6 for EVM interaction
- PostgreSQL 16 + Redis/BullMQ for state and job queues
- Foundry for Solidity contracts

**Key constraints:**
- Must use Alvara's actual platform contracts (reverse-engineered from on-chain data)
- Divestment config immutable after fund creation, stored on-chain
- Distribution to top 100 holders by token balance (not a separate staking contract)
- Bags SDK rate limit: 1,000 req/hour per API key
- Minimum Alvara BSKT seed: 0.1 ETH

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Risk Retirement & Subsystem Proof — Prove every critical subsystem works: Alvara factory, deBridge, Bags SDK, Jupiter, holder resolution
- [ ] M002: Outbound Pipeline (Solana → Alvara) — Reflections flow automatically from Bags.fm into Alvara baskets on Base + Ethereum
- [ ] M003: Return Pipeline & Distribution — Auto-divestment triggers liquidation, proceeds bridge back to Solana and distribute to holders
- [ ] M004: App Store Launch — Bags.fm embedded UI, dashboard, notifications, multi-fund parallel operation

---
depends_on: [M001]
---

# M002: Outbound Pipeline (Solana → Alvara)

**Gathered:** 2026-04-06
**Status:** Ready for planning

## Project Description

After M001 proves each subsystem independently, M002 wires them into a fully automated outbound pipeline running unattended. Reflections accumulate → threshold triggers → swap → bridge → Alvara basket creation or contribution. Plus rebalancing, emergency controls, and the on-chain divestment config registry.

## Why This Milestone

M001 proves the pieces work. M002 proves they work *together, automatically, repeatedly*. This is where "scripts that run" becomes "a system that runs itself." The repeating fund cycle (accumulate → invest → divest → distribute → accumulate again) requires robust state management, checkpoint-based failure recovery, and the on-chain config that makes the whole thing transparent.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Create a fund through an API that sets up the full Solana→EVM pipeline automatically
- Watch reflections accumulate and trigger the outbound pipeline when threshold is met — without any manual intervention
- See their Alvara basket grow as successive reflection cycles deposit into it
- Trigger a rebalance of their basket composition through an API call
- Trigger Emergency Stables to de-risk in market crashes
- Verify their fund's divestment configuration on-chain via the registry contract

### Entry point / environment

- Entry point: REST API endpoints (no UI yet — M004)
- Environment: Node.js service + PostgreSQL + Redis/BullMQ, connected to Solana mainnet + Base/Ethereum mainnet
- Live dependencies: Bags.fm API, Jupiter, deBridge DLN, Alvara contracts, Helius RPC

## Completion Class

- Contract complete means: all pipeline steps work end-to-end with real chains, checkpointed, and recoverable
- Integration complete means: multiple fund cycles complete without manual intervention
- Operational complete means: scheduler runs, failures are recovered, state machine handles all lifecycle transitions

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A fund accumulates reflections, hits threshold, and the outbound pipeline fires automatically
- USDC arrives on Base and is contributed to an Alvara basket without manual steps
- The fund completes at least 2 accumulation→contribution cycles successfully
- Rebalancing works via Alvara's interface (reverse-engineered backend API)
- Emergency Stables converts a basket to stablecoins and reverts
- Divestment config is stored immutably on-chain and readable by anyone

## Risks and Unknowns

- **Alvara backend API reverse-engineering** — rebalancing requires their MEV-protected signing. We need to intercept and replicate these API calls from the bskt.alvara.xyz frontend.
- **Alvara contribution flow** — initial creation takes ETH; subsequent contributions may differ. Need to verify if contribute() accepts direct token deposits or only ETH.
- **Checkpoint recovery under concurrent funds** — multiple funds may have pipelines in different stages simultaneously. Recovery must be per-fund isolated.
- **Solidity registry contract gas costs** — storing immutable structs on-chain has a one-time gas cost. Must be reasonable on both Base and Ethereum.

## Existing Codebase / Prior Art

- M001 deliverables: Alvara factory module, deBridge bridge client, Bags SDK client, Jupiter swap, holder resolution, PostgreSQL fund data model, outbound pipeline orchestrator
- All M001 subsystem modules are the building blocks for M002 automation

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions.

## Relevant Requirements

- R003 — Accumulation threshold trigger (primary)
- R008 — Basket rebalancing via Alvara interface
- R009 — On-chain divestment config registry
- R016 — Protocol fee deduction on Solana side
- R017 — Divestment config immutability
- R021 — Dual-chain support (Base + Ethereum)
- R024 — Emergency Stables circuit breaker

## Scope

### In Scope

- Automated accumulation monitoring (single cron, 6-hour interval)
- Threshold-triggered outbound pipeline execution
- Alvara BSKT contribution (ongoing deposits after initial creation)
- Rebalancing via reverse-engineered Alvara backend API
- Emergency Stables trigger and revert
- On-chain divestment config registry contract (Solidity, deployed on Base + Ethereum)
- Protocol fee deduction on Solana side before pipeline
- Checkpoint-based pipeline failure recovery (resume from failed step)
- REST API for fund management operations (create, rebalance, emergency, status)

### Out of Scope / Non-Goals

- Auto-divestment trigger evaluation (M003)
- Return bridge and distribution (M003)
- Frontend/UI (M004)
- Multi-fund parallel stress testing (M003)
- Wormhole fallback bridge (deferred)

## Technical Constraints

- Single cron job polls all active funds (D009)
- Funds run repeating cycles — no terminal state unless owner shuts down (D010)
- Single registry contract per chain for divestment config (D011)
- Rebalancing routes through Alvara's backend signing (D012)
- Pipeline failures resume from checkpointed step (D013)
- Alvara BSKT minimum seed: 0.1 ETH for creation

## Integration Points

- **M001 subsystem modules** — all consumed as building blocks
- **Alvara backend API** — reverse-engineered from bskt.alvara.xyz for rebalancing and MEV-protected operations
- **BullMQ** — job scheduling for cron and pipeline step execution
- **Redis** — BullMQ backing store and pipeline checkpoint state

## Open Questions

- **Alvara contribute() interface** — Does contributing to an existing BSKT accept direct ERC-20 token deposits, or only ETH that gets swapped? Need to verify from on-chain data or the ERC-7621 spec.
- **Registry contract upgrade path** — The registry itself should be immutable (no proxy), but what if we need to add fields? Consider versioning.
- **Cron job failure** — If the polling cron crashes, how quickly does BullMQ recover it? Need dead-letter queue monitoring.

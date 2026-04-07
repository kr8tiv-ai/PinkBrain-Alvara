---
depends_on: [M001, M002]
---

# M003: Return Pipeline & Distribution

**Gathered:** 2026-04-06
**Status:** Ready for planning

## Project Description

M003 closes the full cycle: auto-divestment triggers evaluate → Alvara "Redeem for ETH" liquidates the basket → ETH swapped to USDC → deBridge bridges USDC back to Solana → top 100 holders resolved from snapshot → proportional distribution with immediate on-chain verification → fund enters next accumulation cycle.

## Why This Milestone

The outbound direction (M002) only proves half the value prop. The return direction — where holders actually receive proceeds — is the moment the product delivers its core promise. This is also where the Fund Engine's multi-fund orchestration is proven under real load with concurrent pipelines.

## User-Visible Outcome

### When this milestone is complete, the user can:

- See their fund automatically divest when time or value threshold triggers fire
- See Alvara basket redeemed for ETH, swapped to USDC, bridged back to Solana
- See proceeds distributed to their top 100 token holders automatically
- See the fund restart its accumulation cycle after distribution completes
- See 3-5+ funds running simultaneously without interference
- Verify every step of the return pipeline on-chain

### Entry point / environment

- Entry point: REST API + BullMQ scheduled jobs (no UI yet)
- Environment: Node.js service + PostgreSQL + Redis/BullMQ, connected to Solana mainnet + Base/Ethereum mainnet
- Live dependencies: Alvara contracts, deBridge DLN, Jupiter, Helius RPC

## Completion Class

- Contract complete means: auto-divestment, return bridge, and distribution all work programmatically
- Integration complete means: full round-trip (accumulate → invest → divest → distribute → accumulate) completes without manual intervention
- Operational complete means: 3-5 funds run in parallel with independent failure domains, Fund Engine handles all lifecycle transitions

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A fund's auto-divestment trigger fires and the full return pipeline executes without manual intervention
- Top 100 holders receive their proportional USDC (or SOL) distribution
- A fund completes at least 2 full round-trip cycles (accumulate → invest → divest → distribute → accumulate again)
- 3-5 funds run concurrently with independent pipelines
- Distribution failures are immediately detected, corrected, and verified on-chain

## Risks and Unknowns

- **Alvara Redeem for ETH via direct contract call** — redemption may require MEV-protected backend signing like rebalancing. If so, we need to replicate Alvara's backend API for redemption too.
- **Bridge timing during divestment** — the return bridge (Base→Solana) adds a time window between redemption and distribution. Holder snapshot is locked at trigger time (D014) to prevent gaming.
- **Distribution to 100 wallets — verify loop** — each transfer must be verified on Solana immediately. Failures must be fixed and re-verified in a tight loop. This adds latency but ensures completeness.
- **Concurrent fund pipeline isolation** — multiple funds divesting simultaneously must not interfere with each other's bridge operations or distribution batches.

## Existing Codebase / Prior Art

- M001 deliverables: all subsystem modules
- M002 deliverables: automated outbound pipeline, accumulation scheduler, on-chain config registry, rebalancing via Alvara API, checkpoint recovery

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions.

## Relevant Requirements

- R010 — Auto-divestment triggers (time + value threshold)
- R011 — Alvara Redeem for ETH liquidation
- R012 — deBridge return bridge (EVM → Solana)
- R013 — Top 100 holder resolution (reuse from M001)
- R014 — Batched distribution to holders
- R015 — Distribution currency choice (USDC or SOL)
- R019 — Full automation — zero manual steps
- R020 — Fund Engine state machine (multi-fund orchestration)
- R025 — Bridge failure recovery
- R026 — Multiple funds running in parallel

## Scope

### In Scope

- Auto-divestment trigger evaluation (time-based, value-threshold, or both)
- Configurable minimum divestment threshold (skip if TVL too low)
- Alvara Redeem for ETH execution
- ETH → USDC swap on EVM side
- deBridge return bridge (EVM → Solana)
- Holder snapshot at trigger time (locked)
- Proportional share calculation
- Batched SPL token distribution with immediate on-chain verification
- Distribution currency swap (USDC → SOL via Jupiter if configured)
- Distribute → verify → fix → verify tight loop
- Fund Engine state machine with BullMQ (multi-fund orchestration)
- Multi-fund parallel execution proof (3-5 funds)
- Full round-trip cycle proof (accumulate → invest → divest → distribute → repeat)

### Out of Scope / Non-Goals

- Frontend/UI (M004)
- Email notifications (M004)
- Wormhole fallback bridge (deferred)
- Auto-rebalancing (deferred R029)
- Time-weighted holder calculations (not requested)

## Technical Constraints

- Holder snapshot at trigger time, not distribution time (D014)
- Distribution: send → verify → fix → verify tight loop (D015)
- Configurable minimum divestment threshold per fund (D016)
- Repeating fund cycles, not terminal (D010)
- ~30 instructions per Solana versioned tx → 4 txs minimum for 100 holders
- Pipeline resume from checkpoint on failure (D013)

## Integration Points

- **M002 pipeline orchestrator** — extended with return direction
- **Alvara contracts** — Redeem for ETH, potentially via backend API
- **deBridge DLN** — return bridge EVM → Solana
- **Jupiter** — USDC → SOL swap if configured
- **Helius RPC** — holder resolution via getProgramAccounts

## Open Questions

- **Alvara Redeem for ETH** — does it return ETH directly or constituent tokens? Docs say "tokens sold for ETH" which implies the contract handles swaps. Verify via on-chain data.
- **Minimum divestment threshold default** — what's a sensible default? Need to estimate gas + bridge costs for a full return pipeline.
- **Concurrent bridge operations** — can deBridge handle multiple simultaneous orders from the same source wallet? Or do we need per-fund EVM wallets?

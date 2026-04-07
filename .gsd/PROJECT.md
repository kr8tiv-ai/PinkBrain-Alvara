# PinkBrain Baskets

## What This Is

A native Solana basket/index fund protocol. Anyone can create a weighted portfolio basket of SPL tokens, and anyone can invest by depositing any token. The protocol handles all swaps (via Jupiter CPI), mints fungible share tokens, and supports permissionless rebalancing. Basket creators actively manage composition and earn management fees. Investors hold standard SPL share tokens that are composable with all Solana DeFi.

No protocol token. No forced allocations. Just baskets + small transparent fees.

## Core Value

Create or invest in managed token baskets on Solana — deposit anything, get diversified exposure, withdraw anytime. Cheaper, simpler, and more transparent than any EVM alternative.

## How It Works

### For Basket Creators
- Create a basket: choose constituent SPL tokens + weights + fee structure
- Manage ongoing: adjust weights, trigger rebalances, monitor performance
- Earn management fees (0-2% annualized on basket NAV, creator-configurable)

### For Investors
- Browse baskets, pick one, deposit any SPL token or SOL
- Jupiter CPI auto-swaps deposit into basket constituents at target weights
- Receive fungible SPL share tokens representing proportional ownership
- Withdraw anytime: burn shares → receive underlying tokens (or auto-swap to single token)

### Fee Model
| Fee | Rate | When | Who Receives |
|-----|------|------|--------------|
| Deposit | 0.1–0.3% | On deposit, before swap | Protocol treasury |
| Withdrawal | 0.1–0.3% | On withdrawal value | Protocol treasury |
| Management | 0–2% annualized | Accrued continuously on NAV | Basket creator |
| Rebalance | Small bounty | When drift exceeds threshold | Keeper (anyone) |

### Architecture
```
┌─────────────────────────────────────────────┐
│             Anchor Program                   │
│                                              │
│  create_basket(mints[], weights[], fees)     │
│    → Basket PDA + Share Mint + Token Vaults  │
│                                              │
│  deposit(basket, amount, deposit_token)      │
│    → Jupiter CPI swaps to constituents       │
│    → Mint proportional share tokens          │
│                                              │
│  withdraw(basket, shares, out_token)         │
│    → Burn shares                             │
│    → Transfer proportional underlying        │
│    → Optional: Jupiter CPI to single token   │
│                                              │
│  rebalance(basket)                           │
│    → Permissionless crank                    │
│    → Jupiter CPI swaps overweight → under    │
│    → Keeper bounty from basket reserves      │
│                                              │
│  update_weights(basket, new_weights[])       │
│    → Creator-only, sets rebalance target     │
│                                              │
└─────────────────────────────────────────────┘

Storage:
  Basket PDA: creator, mints[], weights[], share_mint,
              deposit_fee_bps, withdrawal_fee_bps,
              mgmt_fee_bps, rebalance_threshold_bps,
              total_deposits, created_at, last_rebalance

  Token Vaults: one ATA per constituent, owned by basket PDA

  Share Mint: SPL token, mint authority = basket PDA
```

### What Makes This Better
- **Zero protocol token tax** — 100% of deposit goes into the basket
- **Deposit with anything** — SOL, USDC, or any SPL token. Jupiter handles routing.
- **Fungible shares** — standard SPL token, composable with any Solana DeFi
- **Transparent fees** — on-chain, visible, small
- **Permissionless rebalancing** — anyone can crank it, keeper economics keep it honest
- **No backend dependency** — everything on-chain via Jupiter CPI, no signed routes, no centralized API
- **Active management** — creators adjust weights, earn fees, build reputation
- **Fully managed app** — standalone web app for creating, investing, and managing baskets

## Current State

**Pivot in progress.** Prior work (M001, M002) built cross-chain Alvara integration infrastructure that is now paused. The project direction has shifted to a native Solana basket protocol.

### Completed (paused — cross-chain era)
- ✅ M001: Risk Retirement & Subsystem Proof — Proved all cross-chain subsystems
- ✅ M002: Outbound Pipeline (Solana → Alvara) — Full outbound pipeline + REST API

### Paused
- ⏸️ M003: Return Pipeline & Distribution — Cross-chain return pipeline (superseded)
- ⏸️ M004: App Store Launch — Bags.fm embed (superseded by standalone app)

### Salvageable from prior work
- Jupiter swap integration (M001/S04) — reusable for Solana-native swaps
- Holder resolution (M001/S04) — reusable for basket analytics
- PostgreSQL + Drizzle ORM patterns — reusable for app backend
- Fastify REST API patterns (M002/S05) — reusable for basket management API
- vitest test infrastructure — reusable
- Structured logging patterns — reusable

### New work needed
- Anchor program (basket CRUD, deposit, withdraw, rebalance, fee accrual)
- TypeScript SDK for program interaction
- Web app (Next.js) — basket creation, investment, management dashboard
- Deployment infrastructure

## Tech Stack (planned)

- **On-chain:** Anchor (Rust), SPL Token, Jupiter CPI
- **SDK:** TypeScript + @coral-xyz/anchor
- **App:** Next.js, React, TailwindCSS
- **Backend:** Fastify (reuse), PostgreSQL + Drizzle (reuse), Redis/BullMQ if needed
- **Testing:** vitest (reuse), Anchor test framework (bankrun or local validator)

## Key Decisions

See `.gsd/DECISIONS.md` — D041 through D045 capture the pivot rationale.

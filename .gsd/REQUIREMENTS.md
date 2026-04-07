# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — Any Bags.fm token creator can create an isolated fund instance with its own treasury wallet, Alvara basket, and distribution config
- Class: core-capability
- Status: active
- Description: Any Bags.fm token creator can create an isolated fund instance with its own treasury wallet, Alvara basket, and distribution config
- Why it matters: The app is generic, not $BRAIN-specific — multi-tenancy is the product
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: M002/S01, M003/S01
- Validation: M001/S05: Fund creation with UUID PK, treasury wallet reference, protocolFeeBps field. Schema, repository CRUD, and state machine implemented. Awaits M002 for full end-to-end fund lifecycle.
- Notes: Each fund gets isolated state in PostgreSQL, separate EVM wallet, separate Solana treasury

### R002 — Programmatically configure a token's fee share to direct reflections to the fund's treasury wallet using Bags SDK admin endpoints
- Class: core-capability
- Status: active
- Description: Programmatically configure a token's fee share to direct reflections to the fund's treasury wallet using Bags SDK admin endpoints
- Why it matters: This is the entry point — no fee redirection means no reflection capture
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M002/S01
- Validation: M001/S03: Complete programmatic interface — getAdminTokenList, buildUpdateConfigTransaction (basis points validation), getClaimTransactions, signAndSendClaimTransactions. 42 unit tests, dry-run CLI proof. Awaits live API key validation.
- Notes: Bags SDK POST /fee-share/config with basis points. Token creator must authorize initial redirect (one-time manual step).

### R003 — Treasury wallet monitors accumulated reflections and triggers the outbound pipeline when balance exceeds a configurable threshold (default 5 SOL equivalent)
- Class: primary-user-loop
- Status: active
- Description: Treasury wallet monitors accumulated reflections and triggers the outbound pipeline when balance exceeds a configurable threshold (default 5 SOL equivalent)
- Why it matters: Threshold prevents wasteful small-amount bridges where fees eat the principal
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Scheduled job checks every 6 hours. Threshold configurable per fund at setup.

### R004 — Swap accumulated SOL reflections to USDC on Solana via Jupiter Aggregator before bridging
- Class: core-capability
- Status: active
- Description: Swap accumulated SOL reflections to USDC on Solana via Jupiter Aggregator before bridging
- Why it matters: USDC is the stable bridge asset — bridging raw SOL adds unnecessary price exposure during transit
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M002/S01
- Validation: M001/S04: Jupiter Ultra V3 swap module (getSwapOrder, executeSwap, swapSolToUsdc). Live API proof: 0.01 SOL → 0.80 USDC quote. 24 unit tests. Integrated in S06 outbound pipeline.
- Notes: Jupiter SDK or REST API. Must handle slippage protection.

### R005 — Bridge USDC from Solana to Base or Ethereum via deBridge DLN REST API with 1-2 second fulfillment
- Class: core-capability
- Status: active
- Description: Bridge USDC from Solana to Base or Ethereum via deBridge DLN REST API with 1-2 second fulfillment
- Why it matters: This is the cross-chain link — without it, Solana reflections can't reach EVM baskets
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M002/S01
- Validation: M001/S02: Typed deBridge DLN client with Solana tx preparation pipeline. Live estimate-only dry-run: 0.20 USDC Solana→Base. 37 unit tests. Full bridge pipeline implemented but not exercised with real funds. Integrated in S06 outbound pipeline.
- Notes: Solana chain ID 7565164, Base chain ID 8453, Ethereum chain ID 1. deBridge has zero TVL risk (intent-based). Transfer caps mandatory.

### R007 — Programmatically create an ERC-7621 basket on Alvara's platform by calling the factory contract directly, seeded with minimum 0.1 ETH
- Class: core-capability
- Status: active
- Description: Programmatically create an ERC-7621 basket on Alvara's platform by calling the factory contract directly, seeded with minimum 0.1 ETH
- Why it matters: Basket creation is the EVM-side anchor of every fund instance
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M002/S02
- Validation: S01/T02: Factory interface proven (createBSKT signature, full ABI). MEV analysis of 5 on-chain txs confirms backend-signed swap routes required — direct creation without Alvara's signing API will revert with InvalidSignature. Integration path documented in mev-findings.json. Capability achievable but requires Alvara backend API integration, not just direct contract calls.
- Notes: Each fund gets isolated state in PostgreSQL, separate EVM wallet, separate Solana treasury. BSKT creation requires Alvara backend-signed swap routes — direct contract calls revert without valid _signature and _swapData. Integration with Alvara API or UI automation needed for M002/S02.

### R008 — Token owner can change basket composition via Alvara's two-phase rebalance (sell to WETH → buy new allocation)
- Class: core-capability
- Status: active
- Description: Token owner can change basket composition via Alvara's two-phase rebalance (sell to WETH → buy new allocation)
- Why it matters: Active management is the value prop for fund creators
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Two separate on-chain transactions. MEV-protected via Alvara's backend signing. Owner can only change composition, not divestment config.

### R009 — The divestment split (% to holders vs % to owner) and trigger conditions are stored on-chain so anyone can verify
- Class: core-capability
- Status: active
- Description: The divestment split (% to holders vs % to owner) and trigger conditions are stored on-chain so anyone can verify
- Why it matters: User said "must be transparent" — on-chain is the only trustless way
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: M003/S01
- Validation: unmapped
- Notes: Custom config registry contract on EVM side. Stores: recipient split (basis points), trigger type (time/threshold/both), trigger params, distribution currency choice.

### R010 — Fund auto-liquidates based on configured triggers: time-based schedule, value threshold, or both. Locked at setup.
- Class: primary-user-loop
- Status: active
- Description: Fund auto-liquidates based on configured triggers: time-based schedule, value threshold, or both. Locked at setup.
- Why it matters: Automation is the whole point — the fund must divest without manual intervention
- Source: user
- Primary owning slice: M003/S01
- Supporting slices: M001/S05
- Validation: unmapped
- Notes: Time-based: monthly, quarterly, etc. Value-based: total basket TVL hits target. Both: whichever triggers first.

### R011 — Liquidate basket position by redeeming all LP tokens for ETH via Alvara's existing redemption mechanism
- Class: core-capability
- Status: active
- Description: Liquidate basket position by redeeming all LP tokens for ETH via Alvara's existing redemption mechanism
- Why it matters: This IS the liquidation path — no custom liquidation contract needed
- Source: research
- Primary owning slice: M003/S01
- Supporting slices: none
- Validation: unmapped
- Notes: LP tokens burned → underlying tokens sold to ETH → ETH returned to wallet. MEV-protected.

### R012 — Bridge liquidation proceeds (USDC/ETH) from Base/Ethereum back to Solana via deBridge DLN
- Class: core-capability
- Status: active
- Description: Bridge liquidation proceeds (USDC/ETH) from Base/Ethereum back to Solana via deBridge DLN
- Why it matters: Proceeds must return to Solana for distribution to holders
- Source: user
- Primary owning slice: M003/S02
- Supporting slices: none
- Validation: unmapped
- Notes: ETH → USDC swap on EVM side first (via 1inch or Alvara's swap), then bridge USDC to Solana.

### R013 — Query current top 100 holders of any SPL token mint via Solana RPC (getProgramAccounts with filters, or Helius DAS API)
- Class: core-capability
- Status: active
- Description: Query current top 100 holders of any SPL token mint via Solana RPC (getProgramAccounts with filters, or Helius DAS API)
- Why it matters: Can't distribute to holders without knowing their addresses and proportional shares
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M003/S02
- Validation: M001/S04: Dual-strategy holder resolution — getProgramAccounts with SPL Token filters + Helius DAS auto-fallback. Integer bigint math for percentages. 40 unit tests. CLI proof script.
- Notes: getTokenLargestAccounts returns only 20. Need getProgramAccounts with data size filter for full list. Helius may offer a cleaner API.

### R014 — Distribute divestment proceeds to up to 100 wallets on Solana via batched SPL token transfers with checkpoint recovery
- Class: core-capability
- Status: active
- Description: Distribute divestment proceeds to up to 100 wallets on Solana via batched SPL token transfers with checkpoint recovery
- Why it matters: Distribution is the end of the pipeline — must be reliable and atomic-ish
- Source: user
- Primary owning slice: M003/S03
- Supporting slices: none
- Validation: unmapped
- Notes: ~30 instructions per Solana versioned transaction → 4 transactions minimum for 100 holders. Checkpoint tracking for partial failure recovery.

### R015 — Fund creator chooses at setup whether holders receive USDC or SOL. Choice locked at creation.
- Class: core-capability
- Status: active
- Description: Fund creator chooses at setup whether holders receive USDC or SOL. Choice locked at creation.
- Why it matters: Some holders prefer stable value, some prefer native token
- Source: user
- Primary owning slice: M003/S03
- Supporting slices: M001/S05
- Validation: unmapped
- Notes: If SOL chosen, add a Jupiter USDC→SOL swap before distribution.

### R016 — The app takes a configurable percentage of each fund's reflections before they enter the outbound pipeline
- Class: core-capability
- Status: active
- Description: The app takes a configurable percentage of each fund's reflections before they enter the outbound pipeline
- Why it matters: Revenue model for the application
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: M002/S01
- Validation: unmapped
- Notes: Deducted on Solana side before bridge. Percentage configurable at platform level.

### R017 — Once a fund's divestment config is set (split %, triggers, distribution currency), it cannot be changed
- Class: constraint
- Status: active
- Description: Once a fund's divestment config is set (split %, triggers, distribution currency), it cannot be changed
- Why it matters: Trust model — holders can verify the config once and know it's permanent
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: M003/S01
- Validation: unmapped
- Notes: Enforced by on-chain contract. No admin override.

### R018 — Every operation (fee claim, swap, bridge, basket creation, rebalance, redemption, distribution) must produce verifiable on-chain transaction hashes
- Class: quality-attribute
- Status: active
- Description: Every operation (fee claim, swap, bridge, basket creation, rebalance, redemption, distribution) must produce verifiable on-chain transaction hashes
- Why it matters: User said opaque/unverifiable is a dealbreaker
- Source: user
- Primary owning slice: M004/S03
- Supporting slices: all
- Validation: unmapped
- Notes: All tx hashes persisted in PostgreSQL and displayed in dashboard. Anyone can verify on explorers.

### R019 — After initial fund creation (which requires one manual tx from token creator), the entire pipeline runs without human intervention
- Class: quality-attribute
- Status: active
- Description: After initial fund creation (which requires one manual tx from token creator), the entire pipeline runs without human intervention
- Why it matters: User said manual/slow is a dealbreaker
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: all
- Validation: unmapped
- Notes: One manual step: token creator authorizes fee share redirect at setup. Everything after is automated.

### R020 — Central orchestrator manages N concurrent fund lifecycles, each with independent state, scheduling, and failure recovery
- Class: core-capability
- Status: active
- Description: Central orchestrator manages N concurrent fund lifecycles, each with independent state, scheduling, and failure recovery
- Why it matters: Multi-tenant means multiple funds running simultaneously with isolated failure domains
- Source: inferred
- Primary owning slice: M003/S04
- Supporting slices: M001/S05, M002/S01
- Validation: unmapped
- Notes: BullMQ for job scheduling. Each fund has its own state machine instance. Failures in one fund don't affect others.

### R021 — Fund creator chooses at setup whether their Alvara basket is deployed on Base or Ethereum mainnet
- Class: core-capability
- Status: active
- Description: Fund creator chooses at setup whether their Alvara basket is deployed on Base or Ethereum mainnet
- Why it matters: Base has lower gas, Ethereum has deeper liquidity — choice matters per strategy
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: M001/S01
- Validation: unmapped
- Notes: Alvara launched on Base April 2, 2026. Both chains fully supported. deBridge supports both.

### R022 — The app's frontend is embedded within the Bags.fm app store, not a standalone site
- Class: launchability
- Status: active
- Description: The app's frontend is embedded within the Bags.fm app store, not a standalone site
- Why it matters: User specifically wants it embedded in the Bags.fm ecosystem
- Source: user
- Primary owning slice: M004/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Need to investigate Bags.fm app store embed format during M004. May be iframe or custom integration.

### R023 — Fund owner sees pipeline failures in the dashboard and receives email alerts for stuck/failed operations
- Class: failure-visibility
- Status: active
- Description: Fund owner sees pipeline failures in the dashboard and receives email alerts for stuck/failed operations
- Why it matters: When things fail mid-pipeline, the owner needs to know without checking manually
- Source: user
- Primary owning slice: M004/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Dashboard shows failure state with tx hashes. Email via SendGrid or similar.

### R024 — Ability to trigger Alvara's Emergency Stables function (convert basket to ~95% USDT + 5% ALVA) as an automated or manual circuit breaker
- Class: continuity
- Status: active
- Description: Ability to trigger Alvara's Emergency Stables function (convert basket to ~95% USDT + 5% ALVA) as an automated or manual circuit breaker
- Why it matters: Market crashes or token exploits need immediate de-risking
- Source: inferred
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Alvara built-in feature. Suspends normal operations. Manager can revert when stable.

### R025 — Bridge operations implement automatic retry with exponential backoff, status monitoring, and manual intervention alerts
- Class: continuity
- Status: active
- Description: Bridge operations implement automatic retry with exponential backoff, status monitoring, and manual intervention alerts
- Why it matters: Bridges are the highest-risk component — stuck funds need recovery paths
- Source: inferred
- Primary owning slice: M003/S02
- Supporting slices: M001/S02
- Validation: unmapped
- Notes: deBridge orders have deterministic IDs for status queries. 5 retries over 30 minutes. Alert on exhaustion.

### R026 — System must support 3-5+ active funds running simultaneously to prove multi-tenant architecture
- Class: quality-attribute
- Status: active
- Description: System must support 3-5+ active funds running simultaneously to prove multi-tenant architecture
- Why it matters: User defined "done" as multiple funds running in parallel, not just one
- Source: user
- Primary owning slice: M003/S04
- Supporting slices: M001/S05
- Validation: unmapped
- Notes: Each fund has isolated wallets, state, and job queues. Concurrent bridge operations.

### R027 — Every on-chain transaction across both chains is recorded with hash, timestamp, amount, status, and linked fund/operation
- Class: quality-attribute
- Status: active
- Description: Every on-chain transaction across both chains is recorded with hash, timestamp, amount, status, and linked fund/operation
- Why it matters: Transparency requirement — anyone should be able to trace every dollar
- Source: inferred
- Primary owning slice: M004/S03
- Supporting slices: all
- Validation: unmapped
- Notes: PostgreSQL audit table. Exposed in dashboard and potentially via public API.

## Validated

### R006 — Reverse-engineer Alvara's BSKT factory contract addresses from on-chain transaction data on Base and Ethereum
- Class: core-capability
- Status: validated
- Description: Reverse-engineer Alvara's BSKT factory contract addresses from on-chain transaction data on Base and Ethereum
- Why it matters: No published factory addresses or SDK — this is the only path to programmatic BSKT creation without team coordination
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01/T01: Factory discovered at 0x9ee08080 on Base via deployer interaction scanning. Full ABI (93 entries), proxy detection, and machine-readable config in discovered-contracts.json.
- Notes: ALVA token on Base: 0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb. Inspect creation txs at bskt.alvara.xyz. Alvara's MEV-protected backend signs swap routes — need to determine if direct contract interaction bypasses this.

## Deferred

### R028 — Fallback to Wormhole SDK if deBridge is unavailable or fails repeatedly
- Class: continuity
- Status: deferred
- Description: Fallback to Wormhole SDK if deBridge is unavailable or fails repeatedly
- Why it matters: Redundancy for the highest-risk component
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred because deBridge has zero exploit history and adding a second bridge doubles the integration surface. Revisit if deBridge proves unreliable.

### R029 — Automatic periodic rebalancing on a schedule (weekly, monthly) with predefined strategies
- Class: differentiator
- Status: deferred
- Description: Automatic periodic rebalancing on a schedule (weekly, monthly) with predefined strategies
- Why it matters: Reduces manual management overhead for fund creators
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred because manual rebalance is sufficient for launch. Add when user demand is proven.

### R030 — Preset basket compositions that fund creators can choose from during setup
- Class: differentiator
- Status: deferred
- Description: Preset basket compositions that fund creators can choose from during setup
- Why it matters: Lowers barrier to entry for non-expert fund creators
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: User said custom only. Deferred unless demand emerges.

## Out of Scope

### R031 — A dedicated staking contract where users lock tokens to qualify for distributions
- Class: anti-feature
- Status: out-of-scope
- Description: A dedicated staking contract where users lock tokens to qualify for distributions
- Why it matters: Prevents scope creep — distribution is to top 100 holders by balance, not stakers
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: User explicitly chose top 100 holders model.

### R032 — Allowing the fund creator to change divestment split, triggers, or distribution currency after fund creation
- Class: anti-feature
- Status: out-of-scope
- Description: Allowing the fund creator to change divestment split, triggers, or distribution currency after fund creation
- Why it matters: Immutability is the trust model — changing it would undermine holder confidence
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: User explicitly chose composition-only changes.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S05 | M002/S01, M003/S01 | M001/S05: Fund creation with UUID PK, treasury wallet reference, protocolFeeBps field. Schema, repository CRUD, and state machine implemented. Awaits M002 for full end-to-end fund lifecycle. |
| R002 | core-capability | active | M001/S03 | M002/S01 | M001/S03: Complete programmatic interface — getAdminTokenList, buildUpdateConfigTransaction (basis points validation), getClaimTransactions, signAndSendClaimTransactions. 42 unit tests, dry-run CLI proof. Awaits live API key validation. |
| R003 | primary-user-loop | active | M002/S01 | M001/S03 | unmapped |
| R004 | core-capability | active | M001/S04 | M002/S01 | M001/S04: Jupiter Ultra V3 swap module (getSwapOrder, executeSwap, swapSolToUsdc). Live API proof: 0.01 SOL → 0.80 USDC quote. 24 unit tests. Integrated in S06 outbound pipeline. |
| R005 | core-capability | active | M001/S02 | M002/S01 | M001/S02: Typed deBridge DLN client with Solana tx preparation pipeline. Live estimate-only dry-run: 0.20 USDC Solana→Base. 37 unit tests. Full bridge pipeline implemented but not exercised with real funds. Integrated in S06 outbound pipeline. |
| R006 | core-capability | validated | M001/S01 | none | S01/T01: Factory discovered at 0x9ee08080 on Base via deployer interaction scanning. Full ABI (93 entries), proxy detection, and machine-readable config in discovered-contracts.json. |
| R007 | core-capability | active | M001/S01 | M002/S02 | S01/T02: Factory interface proven (createBSKT signature, full ABI). MEV analysis of 5 on-chain txs confirms backend-signed swap routes required — direct creation without Alvara's signing API will revert with InvalidSignature. Integration path documented in mev-findings.json. Capability achievable but requires Alvara backend API integration, not just direct contract calls. |
| R008 | core-capability | active | M002/S03 | none | unmapped |
| R009 | core-capability | active | M001/S05 | M003/S01 | unmapped |
| R010 | primary-user-loop | active | M003/S01 | M001/S05 | unmapped |
| R011 | core-capability | active | M003/S01 | none | unmapped |
| R012 | core-capability | active | M003/S02 | none | unmapped |
| R013 | core-capability | active | M001/S04 | M003/S02 | M001/S04: Dual-strategy holder resolution — getProgramAccounts with SPL Token filters + Helius DAS auto-fallback. Integer bigint math for percentages. 40 unit tests. CLI proof script. |
| R014 | core-capability | active | M003/S03 | none | unmapped |
| R015 | core-capability | active | M003/S03 | M001/S05 | unmapped |
| R016 | core-capability | active | M001/S05 | M002/S01 | unmapped |
| R017 | constraint | active | M001/S05 | M003/S01 | unmapped |
| R018 | quality-attribute | active | M004/S03 | all | unmapped |
| R019 | quality-attribute | active | M003/S04 | all | unmapped |
| R020 | core-capability | active | M003/S04 | M001/S05, M002/S01 | unmapped |
| R021 | core-capability | active | M002/S02 | M001/S01 | unmapped |
| R022 | launchability | active | M004/S01 | none | unmapped |
| R023 | failure-visibility | active | M004/S02 | none | unmapped |
| R024 | continuity | active | M002/S03 | none | unmapped |
| R025 | continuity | active | M003/S02 | M001/S02 | unmapped |
| R026 | quality-attribute | active | M003/S04 | M001/S05 | unmapped |
| R027 | quality-attribute | active | M004/S03 | all | unmapped |
| R028 | continuity | deferred | none | none | unmapped |
| R029 | differentiator | deferred | none | none | unmapped |
| R030 | differentiator | deferred | none | none | unmapped |
| R031 | anti-feature | out-of-scope | none | none | n/a |
| R032 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 26
- Mapped to slices: 26
- Validated: 1 (R006)
- Unmapped active requirements: 0

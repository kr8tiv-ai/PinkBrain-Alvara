```
 ____  _       _    ____            _            _    _
|  _ \(_)_ __ | | _| __ ) _ __ __ _(_)_ __      / \  | |_   ____ _ _ __ __ _
| |_) | | '_ \| |/ /  _ \| '__/ _` | | '_ \   / _ \ | \ \ / / _` | '__/ _` |
|  __/| | | | |   <| |_) | | | (_| | | | | | / ___ \| |\ V / (_| | | | (_| |
|_|   |_|_| |_|_|\_\____/|_|  \__,_|_|_| |_|/_/   \_\_| \_/ \__,_|_|  \__,_|
```

# PinkBrain Alvara

**Cross-chain basket token infrastructure for the $BRAIN ecosystem.**
ERC-7621 BSKT index funds on Base, powered by Bags.fm fee sharing on Solana.

---

`ERC-7621` | `Base Mainnet` | `TypeScript` | `Alvara Protocol` | `Bags.fm Integration` | `v0.1.0`

---

## The Plan

Every night, Pinky asks the same question: *"What are we going to do tomorrow night, Brain?"*

The answer: **build on-chain index funds that anyone can create, rebalance, and manage -- programmatically.**

PinkBrain Alvara is the basket token engine of the [kr8tiv-ai](https://github.com/kr8tiv-ai) ecosystem. It connects Solana-side fee revenue from [Bags.fm](https://bags.fm) to Alvara Protocol's ERC-7621 factory on Base, enabling the full lifecycle of multi-asset basket tokens (BSKTs) -- from fee claiming and cross-chain bridging to basket creation, contribution, rebalancing, and emergency management.

> Part of the **Pinky and the Brain** product suite.
> $BRAIN token on Solana | [pinkyandthebrain.fun](https://pinkyandthebrain.fun)

---

## What Are BSKT Tokens?

A **BSKT** (Basket Token) is an on-chain index fund implemented as a single ERC-20 LP token under the [ERC-7621](https://eips.ethereum.org/EIPS/eip-7621) standard. Each BSKT holds multiple constituent tokens at defined weights (basis points summing to 10,000), allowing holders to gain diversified exposure through one token.

Think of it as an ETF -- but permissionless, transparent, and composable.

| Property | Detail |
|---|---|
| **Standard** | ERC-7621 (Multi-Token Basket) |
| **Weight System** | Basis points (10,000 bps = 100%) |
| **Proxy Pattern** | EIP-1967 Transparent Upgradeable |
| **Chain** | Base Mainnet (Chain ID 8453) |
| **Factory** | Alvara Protocol factory contracts |

---

## Architecture

```
                        SOLANA                                    BASE
  +-------------------------------------------------+  +---------------------------+
  |                                                   |  |                           |
  |  Bags.fm Fee Share                                |  |   Alvara ERC-7621         |
  |  +-----------+    +------------+                  |  |   +-----------------+     |
  |  | $BRAIN    |--->| Fee Claim  |                  |  |   | BSKT Factory    |     |
  |  | holders   |    | (bags SDK) |                  |  |   | (auto-discovered)|    |
  |  +-----------+    +-----+------+                  |  |   +--------+--------+     |
  |                         |                         |  |            |              |
  |                         v                         |  |            v              |
  |                   +-----+------+                  |  |   +--------+--------+     |
  |                   | Jupiter    |                  |  |   | BSKT Tokens     |     |
  |                   | SOL->USDC  |                  |  |   | (ERC-20 LP)     |     |
  |                   +-----+------+                  |  |   +--------+--------+     |
  |                         |                         |  |            |              |
  |                         v                         |  |            v              |
  |                   +-----+------+   deBridge DLN   |  |   +--------+--------+     |
  |                   | Bridge     |----------------->|  |   | Rebalance /     |     |
  |                   | USDC->Base |                  |  |   | Contribute /    |     |
  |                   +------------+                  |  |   | Emergency       |     |
  |                                                   |  |   +-----------------+     |
  +-------------------------------------------------+  +---------------------------+

                              |
                              v

                    +-------------------+
                    | Outbound Pipeline |
                    | (claim -> swap -> |
                    |  bridge -> BSKT)  |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |   Scheduler       |
                    |   (BullMQ cron)   |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |   REST API        |
                    |   (Fastify)       |
                    +-------------------+
```

---

## Feature Set

### On-Chain Operations

| Feature | Description |
|---|---|
| **Factory Discovery** | Traces the ALVA token deployer on Base, enumerates deployed contracts, scores candidates by factory signals, and resolves the verified ABI. No hardcoded addresses. |
| **BSKT Creation** | Programmatic basket creation via the factory with gas estimation, MEV protection analysis, revert reason extraction, and event log decoding. |
| **BSKT Contribution** | Contribute ETH to existing baskets. Fetches backend-signed swap routes from the Alvara API, calls `contribute()`, and verifies LP token balance increase. |
| **BSKT Rebalancing** | Change token allocations on live baskets. Validates ownership, fetches signed swap routes, and executes `rebalance()` with configurable modes. |
| **Emergency Stables** | Panic button: convert a BSKT to ~95% USDT + 5% ALVA. Outputs a snapshot JSON for later revert to original composition. |
| **ERC-7621 Verification** | Full compliance checker -- ERC-165 interface support, weight validation (sum to 10,000 bps), supply checks, ERC-173 ownership, and ERC-20 metadata. |
| **MEV Analysis** | Read-only analysis of recent `createBSKT` transactions to reverse-engineer signing requirements and swap data patterns. |
| **Proxy Detection** | EIP-1967 proxy pattern detection reads implementation and admin storage slots to resolve actual contract logic. |
| **Registry Deployment** | Deploy the DivestmentRegistry contract to Base or Ethereum mainnet. |

### Cross-Chain Pipeline

| Feature | Description |
|---|---|
| **Bags.fm Fee Share** | Query admin status, update fee share config, query claimable positions, and claim accumulated fees via the Bags SDK. |
| **Jupiter Swaps** | SOL to USDC conversion via Jupiter Ultra V3 with estimate-only dry-run mode. |
| **deBridge Bridging** | Bridge USDC from Solana to Base via deBridge DLN API with estimation, execution, and fulfillment tracking. |
| **Outbound Pipeline** | End-to-end automation: claim fees, swap to USDC, bridge to Base, and execute BSKT operations. |
| **Holder Resolution** | Resolve top holders of any SPL token mint on Solana with DAS API support for faster resolution. |

### Infrastructure

| Feature | Description |
|---|---|
| **Accumulation Scheduler** | BullMQ repeatable jobs on configurable cron schedules for automated pipeline execution. |
| **REST API** | Fastify server for fund management, pipeline status, and external integrations. |
| **PostgreSQL Data Model** | Full fund lifecycle tracking -- creation, state machines, wallet association, divestment configs, pipeline runs, and transaction recording. |
| **Multi-Explorer API** | Dual-backend block explorer support (Blockscout primary, Etherscan V2 fallback) with rate limiting and exponential backoff. |

---

## Project Structure

```
PinkBrain-Alvara/
|
+-- src/
|   +-- alvara/              # ERC-7621 ABI, factory wrapper, rebalance, contribute
|   +-- api/                 # Fastify REST server
|   +-- bags/                # Bags SDK client, fee share, fee claim
|   +-- config/              # Chain configs, Solana config, discovered contracts
|   +-- db/                  # Drizzle ORM schema, connection, fund repository
|   +-- debridge/            # deBridge DLN API, Solana transaction building
|   +-- holders/             # SPL token holder resolution
|   +-- jupiter/             # Jupiter Ultra V3 swap integration
|   +-- pipeline/            # Outbound pipeline orchestration
|   +-- registry/            # DivestmentRegistry deployment
|   +-- scheduler/           # BullMQ queue, accumulation worker
|   +-- utils/               # Basescan API, proxy detection
|
+-- scripts/
|   +-- discover-factory.ts       # On-chain factory discovery
|   +-- create-bskt.ts            # BSKT creation with MEV fallback
|   +-- verify-bskt.ts            # ERC-7621 compliance checker
|   +-- contribute-bskt.ts        # Contribute ETH to a BSKT
|   +-- rebalance-bskt.ts         # Change basket allocations
|   +-- emergency-stables.ts      # Panic conversion + snapshot revert
|   +-- analyze-mev.ts            # Read-only MEV transaction analysis
|   +-- bags-fee-share.ts         # Fee share admin and claiming
|   +-- jupiter-swap.ts           # SOL->USDC via Jupiter
|   +-- bridge-sol-to-base.ts     # USDC bridge via deBridge DLN
|   +-- check-bridge-status.ts    # Bridge fulfillment tracker
|   +-- resolve-holders.ts        # SPL token holder resolution
|   +-- outbound-pipeline.ts      # End-to-end pipeline runner
|   +-- db-seed.ts                # Test fund seeding
|   +-- deploy-registry.ts        # DivestmentRegistry deployer
|   +-- discover-alvara-api.ts    # Contract topology discovery
|   +-- fetch-bsktpair-abi.ts     # BSKTPair ABI via beacon chain
|   +-- start-scheduler.ts        # BullMQ scheduler entry point
|   +-- start-api.ts              # REST API entry point
|
+-- package.json
+-- tsconfig.json
+-- .env.example
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Language** | TypeScript 5.7 (strict, ESM) |
| **EVM Client** | Viem 2.23 |
| **Solana Client** | @solana/web3.js 1.98 |
| **Bags Integration** | @bagsfm/bags-sdk 1.3 |
| **Database** | PostgreSQL via Drizzle ORM |
| **Queue** | BullMQ (Redis-backed) |
| **API Server** | Fastify 5.8 |
| **Bridge** | deBridge DLN |
| **DEX** | Jupiter Ultra V3 |
| **Target Chain** | Base Mainnet (8453) |
| **Token Standard** | ERC-7621 / EIP-1967 |
| **Block Explorers** | Blockscout + Etherscan V2 |
| **Runtime** | Node.js >= 20 |

---

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/kr8tiv-ai/PinkBrain-Alvara.git
cd PinkBrain-Alvara
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `BASESCAN_API_KEY` | Optional | Etherscan V2 unified key for faster API calls |
| `PRIVATE_KEY` | For Base ops | Hex-encoded key for BSKT creation/management |
| `SOL_PRIVATE_KEY` | For Solana ops | Base58-encoded key for swaps, bridging, claiming |
| `SOL_RPC_URL` | Optional | Solana RPC (defaults to public mainnet-beta) |
| `BAGS_API_KEY` | For fee share | Bags.fm developer API key |
| `DATABASE_URL` | For pipeline | PostgreSQL connection string |

### 3. Discover the Factory

```bash
npm run discover
```

Traces the ALVA deployer on Base, scores contract candidates, fetches verified ABIs, and writes results to `src/config/discovered-contracts.json`.

### 4. Create a Basket

```bash
PRIVATE_KEY=0x... npm run create-bskt
```

### 5. Verify ERC-7621 Compliance

```bash
npm run verify-bskt
```

---

## Commands Reference

### Base Chain Operations

| Command | Script | Description |
|---|---|---|
| `npm run discover` | `discover-factory.ts` | Auto-discover Alvara factory contracts |
| `npm run create-bskt` | `create-bskt.ts` | Create a new BSKT via the factory |
| `npm run verify-bskt` | `verify-bskt.ts` | Run ERC-7621 compliance checks |

### Solana Operations

| Command | Script | Description |
|---|---|---|
| `npm run bags-fee-share` | `bags-fee-share.ts` | Query and claim Bags.fm fee shares |
| `npm run jupiter-swap` | `jupiter-swap.ts` | Swap SOL to USDC via Jupiter |
| `npm run jupiter-estimate` | `jupiter-swap.ts` | Estimate swap without executing |
| `npm run resolve-holders` | `resolve-holders.ts` | Resolve top SPL token holders |

### Cross-Chain

| Command | Script | Description |
|---|---|---|
| `npm run bridge` | `bridge-sol-to-base.ts` | Bridge USDC from Solana to Base |
| `npm run bridge-estimate` | `bridge-sol-to-base.ts` | Estimate bridge cost (dry run) |
| `npm run bridge-status` | `check-bridge-status.ts` | Check bridge fulfillment status |
| `npm run outbound-pipeline` | `outbound-pipeline.ts` | Full claim -> swap -> bridge pipeline |

### Infrastructure

| Command | Script | Description |
|---|---|---|
| `npm run scheduler` | `start-scheduler.ts` | Start BullMQ accumulation scheduler |
| `npm run api` | `start-api.ts` | Start Fastify REST API server |
| `npm run db-seed` | `db-seed.ts` | Seed database with test fund data |

---

## On-Chain Contracts

| Contract | Address | Chain |
|---|---|---|
| **ALVA Token** | `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb` | Base |
| **BSKT Factory** | Auto-discovered via `npm run discover` | Base |
| **WETH** | `0x4200000000000000000000000000000000000006` | Base |
| **USDC** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Base |

---

## ERC-7621 Verification Output

```json
{
  "verified": true,
  "bsktAddress": "0x...",
  "name": "AI+DeFi Index",
  "symbol": "AIDX",
  "constituents": [
    { "token": "0x...", "weight": "5000" },
    { "token": "0x...", "weight": "3000" },
    { "token": "0x...", "weight": "2000" }
  ],
  "totalWeightBps": "10000",
  "checks": [
    { "name": "ERC-165 supported",     "passed": true },
    { "name": "ERC-7621 interface",     "passed": true },
    { "name": "constituents non-empty", "passed": true },
    { "name": "weights sum to 10000",   "passed": true },
    { "name": "totalSupply > 0",        "passed": true },
    { "name": "owner is non-zero",      "passed": true },
    { "name": "has name",               "passed": true },
    { "name": "has symbol",             "passed": true }
  ]
}
```

---

## The $BRAIN Ecosystem

All PinkBrain products are powered by the **$BRAIN** token on Solana through Bags.fm fee-sharing infrastructure.

| Project | What It Does |
|---|---|
| **[PinkBrain Router](https://github.com/kr8tiv-ai/PinkBrain-Router)** | Fee-funded OpenRouter API credits for 300+ AI models |
| **[PinkBrain LP](https://github.com/kr8tiv-ai/PinkBrain-lp)** | Auto-compounding Meteora DAMM v2 liquidity |
| **[PinkBrain Alvara](https://github.com/kr8tiv-ai/PinkBrain-Alvara)** | ERC-7621 basket token infrastructure (this repo) |

> *"The same thing we do every night -- try to take over the world."*
>
> One basket at a time.

---

## Contributing

Issues and PRs welcome at [kr8tiv-ai/PinkBrain-Alvara](https://github.com/kr8tiv-ai/PinkBrain-Alvara).

## License

MIT -- see [LICENSE](LICENSE) for details.

---

Built by [Matt Haynes](https://github.com/Matt-Aurora-Ventures) / [kr8tiv-ai](https://github.com/kr8tiv-ai) | [pinkyandthebrain.fun](https://pinkyandthebrain.fun)

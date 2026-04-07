<div align="center">

# PinkBrain Alvara

### *On-Chain Basket Token Infrastructure for Bags.fm*

<img src="https://img.shields.io/badge/BAGS_STORE-INTEGRATION-FF00AA?style=for-the-badge&labelColor=1a1a2e" alt="Bags Store" />
<img src="https://img.shields.io/badge/BASE_MAINNET-LIVE-0052FF?style=for-the-badge&labelColor=1a1a2e&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMCIgY3k9IjEwIiByPSI4IiBmaWxsPSIjMDA1MkZGIi8+PC9zdmc+" alt="Base Mainnet" />
<img src="https://img.shields.io/badge/ERC--7621-BSKT_PROTOCOL-9945FF?style=for-the-badge&labelColor=1a1a2e" alt="ERC-7621" />

<br /><br />

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Viem](https://img.shields.io/badge/Viem-2.23-1C1C1C?style=flat-square)](https://viem.sh)
[![Base](https://img.shields.io/badge/Chain-Base_(8453)-0052FF?style=flat-square)](https://base.org)
[![License](https://img.shields.io/badge/License-MIT-00F0FF?style=flat-square)](LICENSE)

---

**Programmatic BSKT (Basket Token) creation and verification on Base**
**via Alvara's ERC-7621 factory contracts.**

[Bags Store](https://bags.fm) | [Alvara Protocol](https://alvara.xyz) | [ERC-7621 Spec](https://eips.ethereum.org/EIPS/eip-7621) | [kr8tiv-ai](https://github.com/kr8tiv-ai)

</div>

---

## What is PinkBrain Alvara?

PinkBrain Alvara is the **on-chain basket token engine** for the kr8tiv-ai ecosystem. It connects to [Alvara Protocol](https://alvara.xyz)'s ERC-7621 factory on **Base mainnet** to programmatically **discover, create, and verify BSKT (Basket Token) positions** — multi-token index funds represented as a single ERC-20 LP token.

This powers the **Bags Store integration** — enabling $KR8TIV holders to create and manage diversified on-chain baskets directly through the Bags.fm platform.

### How It Works

```
  $KR8TIV holder            PinkBrain Alvara              Base Mainnet
  ──────────────            ────────────────              ─────────────
       |                          |                            |
       |   "Create AI+DeFi       |                            |
       |    basket"               |                            |
       |─────────────────────────>|                            |
       |                          |   discover factory         |
       |                          |──────────────────────────> |
       |                          |   <── factory @ 0x9ee...   |
       |                          |                            |
       |                          |   createBSKT(tokens,       |
       |                          |     weights, seed ETH)     |
       |                          |──────────────────────────> |
       |                          |   <── BSKT LP token minted |
       |                          |                            |
       |                          |   verifyBSKT(address)      |
       |                          |──────────────────────────> |
       |                          |   <── ERC-7621 compliant   |
       |   <── BSKT verified,     |                            |
       |       ready on Bags      |                            |
```

---

## Key Features

<table>
<tr><td width="30%"><b>Factory Discovery</b></td><td>Automatically discovers Alvara's BSKT factory contract from on-chain data — no hardcoded addresses needed. Traces from the ALVA token deployer through contract interactions and scores candidates by factory signals.</td></tr>
<tr><td><b>ERC-7621 Verification</b></td><td>Full compliance checker for BSKT tokens — validates ERC-165 interface support, constituent weights sum to 10000 bps, non-zero supply, valid ownership (ERC-173), and ERC-20 metadata.</td></tr>
<tr><td><b>Proxy Detection</b></td><td>EIP-1967 proxy pattern detection reads implementation and admin storage slots to resolve the actual contract logic behind upgradeable proxies.</td></tr>
<tr><td><b>BSKT Creation</b></td><td>Programmatic basket creation with gas estimation, MEV protection analysis, revert reason extraction, and event log decoding to extract the new BSKT address.</td></tr>
<tr><td><b>MEV Analysis</b></td><td>When direct creation fails (signature-gated factories), analyzes recent successful transactions to reverse-engineer signing requirements and swap data patterns.</td></tr>
<tr><td><b>Multi-Explorer API</b></td><td>Dual-backend block explorer support — Blockscout (free, no key) as primary, Etherscan V2 as fallback. Rate-limited with exponential backoff and automatic retries.</td></tr>
</table>

---

## Bags Store Integration

PinkBrain Alvara is designed to plug into the **Bags.fm store** as a basket creation and management tool for $KR8TIV token holders:

| Integration Point | Description |
|---|---|
| **Basket Discovery** | Browse existing BSKTs on Base via the factory index |
| **One-Click Creation** | Create diversified baskets with configurable token weights |
| **Compliance Verification** | Verify any BSKT meets ERC-7621 spec before listing |
| **Fee Sharing** | Revenue from BSKT operations flows back to $KR8TIV holders via Bags.fm |
| **Portfolio Tracking** | Read constituent tokens, weights, reserves, and total basket value on-chain |

### $KR8TIV Ecosystem

Part of the **kr8tiv-ai** product suite powered by the **$KR8TIV** token on Solana through Bags.fm fee-sharing infrastructure.

---

## Architecture

```
PinkBrain-Alvara/
+-- src/
|   +-- alvara/
|   |   +-- erc7621.ts          # ERC-7621 ABI, read functions, BSKT verifier
|   |   +-- factory.ts          # Factory wrapper — state reads, BSKT creation, calldata decoder
|   |
|   +-- config/
|   |   +-- chains.ts           # Base chain config, known addresses (ALVA, WETH, USDC)
|   |   +-- discovered-contracts.json   # Auto-generated factory discovery output
|   |
|   +-- utils/
|       +-- basescan.ts         # Dual block explorer API (Blockscout + Etherscan V2)
|       +-- proxy.ts            # EIP-1967 proxy detection
|
+-- scripts/
|   +-- discover-factory.ts     # On-chain factory discovery pipeline
|   +-- create-bskt.ts          # BSKT creation with MEV analysis fallback
|
+-- package.json
+-- tsconfig.json
+-- .env.example
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Language** | TypeScript 5.7 (strict mode) |
| **Chain Client** | Viem 2.23 |
| **Target Chain** | Base Mainnet (Chain ID 8453) |
| **Token Standard** | ERC-7621 (Multi-Token Basket) |
| **Proxy Standard** | EIP-1967 (Transparent Upgradeable Proxy) |
| **Block Explorer** | Blockscout (primary) / Etherscan V2 (fallback) |
| **Runtime** | Node.js >= 20, ESM modules |

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/kr8tiv-ai/PinkBrain-Alvara.git
cd PinkBrain-Alvara
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Optional: add BASESCAN_API_KEY for faster API calls
# Required for creation: add PRIVATE_KEY
```

### 3. Discover Factory

```bash
npm run discover
```

Traces the ALVA token deployer on Base, enumerates all deployed contracts and interaction targets, scores candidates by factory signals (name, ABI functions, proxy patterns), fetches the verified ABI, and writes the result to `src/config/discovered-contracts.json`.

### 4. Create a BSKT

```bash
PRIVATE_KEY=0x... npm run create-bskt
```

Attempts to create a basket via the factory. If MEV protection blocks the direct call, automatically falls back to on-chain MEV analysis and writes findings to `src/config/mev-findings.json`.

### 5. Verify a BSKT

```bash
npm run verify-bskt
```

Runs ERC-7621 compliance checks against a BSKT address — interface support, weight validation, supply checks, ownership, and metadata.

---

## On-Chain Contracts

| Contract | Address | Role |
|----------|---------|------|
| **ALVA Token** | `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb` | Alvara governance token (Base) |
| **BSKT Factory** | Auto-discovered via `npm run discover` | Creates and indexes BSKTs |
| **WETH** | `0x4200000000000000000000000000000000000006` | Wrapped ETH on Base |
| **USDC** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Native USDC on Base |

---

## ERC-7621 Verification Report

The verifier produces a structured JSON report:

```json
{
  "verified": true,
  "bsktAddress": "0x...",
  "interfaceSupported": true,
  "name": "Example Basket",
  "symbol": "EBSKT",
  "constituents": [
    { "token": "0x...", "weight": "5000" },
    { "token": "0x...", "weight": "5000" }
  ],
  "totalWeightBps": "10000",
  "totalSupply": "1000000000000000000",
  "owner": "0x...",
  "checks": [
    { "name": "ERC-165 supported", "passed": true },
    { "name": "ERC-7621 interface", "passed": true },
    { "name": "constituents non-empty", "passed": true },
    { "name": "weights sum to 10000", "passed": true },
    { "name": "totalSupply > 0", "passed": true },
    { "name": "owner is non-zero", "passed": true },
    { "name": "has name", "passed": true },
    { "name": "has symbol", "passed": true }
  ]
}
```

---

## The kr8tiv-ai Ecosystem

| Project | Description |
|---------|-------------|
| **[KIN](https://github.com/kr8tiv-ai/Kin)** | AI companion platform — 57 3D characters, 6 bloodlines |
| **[PinkBrain Router](https://github.com/kr8tiv-ai/PinkBrain-Router)** | Bags.fm fee-funded OpenRouter API credits for 300+ AI models |
| **[PinkBrain LP](https://github.com/kr8tiv-ai/PinkBrain-lp)** | Auto-compounding Meteora DAMM v2 liquidity |
| **[PinkBrain Alvara](https://github.com/kr8tiv-ai/PinkBrain-Alvara)** | ERC-7621 basket token infrastructure (this repo) |
| **[Runtime Truth Contracts](https://github.com/kr8tiv-ai/kr8tiv-runtime-truth-contracts)** | Schema-first runtime contracts |

---

## Contributing

Issues and PRs welcome at [kr8tiv-ai/PinkBrain-Alvara](https://github.com/kr8tiv-ai/PinkBrain-Alvara).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<div align="center">

Built by [Matt Haynes](https://github.com/Matt-Aurora-Ventures) / [kr8tiv-ai](https://github.com/kr8tiv-ai)

</div>

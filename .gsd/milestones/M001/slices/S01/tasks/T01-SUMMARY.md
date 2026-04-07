---
id: T01
parent: S01
milestone: M001
provides:
  - TypeScript project scaffold with viem, tsx, dotenv
  - Blockscout/Etherscan V2 API helper with rate limiting and retries
  - EIP-1967 proxy detection utility
  - Factory discovery script that traces from ALVA token → deployer → factory
  - discovered-contracts.json with full verified ABI (93 entries, 54 functions)
key_files:
  - package.json
  - src/config/chains.ts
  - src/utils/basescan.ts
  - src/utils/proxy.ts
  - scripts/discover-factory.ts
  - src/config/discovered-contracts.json
key_decisions:
  - Used Blockscout free API instead of Etherscan V2 (requires paid key for Base chain)
  - Discovery strategy: trace deployer interactions not just deployments (factory was deployed by different address but called by ALVA deployer)
patterns_established:
  - Structured JSON logging at each discovery phase for observability
  - Basescan API wrapper normalizes Blockscout V2 responses to Etherscan-compatible types
  - Multi-signal scoring system for contract identification (name, ABI functions, deployer calls, proxy status)
observability_surfaces:
  - Structured JSON logs to stdout at each discovery phase (step_a through step_f)
  - Error JSON on stderr with phase and error message
  - Exit code 0 on success, 1 on failure
duration: 45min
verification_result: passed
blocker_discovered: false
---

# T01: Scaffold project and discover Alvara factory contract on Base

**Discovered Alvara BSKT factory at 0x9ee08080 on Base with full 93-entry verified ABI including createBSKT**

## What Happened

Scaffolded the TypeScript project from scratch and built a factory discovery pipeline. The initial approach using Basescan's V1 API failed — it was deprecated in favor of Etherscan V2. Etherscan V2 requires a paid API key for non-Ethereum chains, so I switched to Blockscout's free API as the primary data source (Etherscan V2 remains available as fallback when a key is configured).

The discovery strategy needed refinement: the ALVA deployer (`0xc74f5120...`) deployed 14 contracts on Base, but the factory wasn't among them. The factory (`0x9ee08080...`) was deployed by a different address (`0x6ccBA91...`) — likely a separate deployment infrastructure. The key insight was checking the deployer's *interaction targets*, not just deployed contracts. The ALVA deployer called `createBSKT` on the factory, which was the smoking gun.

The factory is a TransparentUpgradeableProxy pointing to implementation `0x296baaa6...` (named "Factory"), with a verified ABI containing 54 functions — including `createBSKT`, `router`, `bsktImplementation`, `bsktList`, `totalBSKT`, and fee/role management functions. A sample BSKT was also identified at `0x056ef071...` (the deployer contributed to it).

## Verification

All three verification criteria from the task plan pass:

1. **`npm install` completes without errors** — ✅ 20 packages installed, 0 vulnerabilities
2. **`npx tsx scripts/discover-factory.ts` exits 0 with JSON containing factoryAddress** — ��� exits 0, outputs `factoryAddress: 0x9ee08080161d443112ab5d9a3ca96010e569e229`
3. **`discovered-contracts.json` contains factoryAddress, abi (non-empty), isProxy (boolean), chainId (8453)** — ✅ all present and correct

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm install --silent` | 0 | ✅ pass | ~40s |
| 2 | `npx tsx scripts/discover-factory.ts` | 0 | ✅ pass | ~105s |
| 3 | `node -e "const d=require('./src/config/discovered-contracts.json'); console.log(/^0x[0-9a-fA-F]{40}$/.test(d.factoryAddress), d.abi.length>0, typeof d.isProxy==='boolean', d.chainId===8453)"` | 0 | ✅ pass (true true true true) | <1s |

## Diagnostics

- `npx tsx scripts/discover-factory.ts` outputs structured JSON at each phase — grep for `"phase":"factory_selected"` to see the winning candidate
- `src/config/discovered-contracts.json` is the machine-readable output consumed by T02
- `knownFunctions` array in the JSON lists all 54 verified function names
- `relatedContracts.sampleBskt` contains an existing BSKT address for reference

## Deviations

1. **Basescan V1 → Blockscout**: Etherscan deprecated V1 APIs and V2 requires a paid key for Base chain. Switched to Blockscout's free V2 API as primary source with Etherscan V2 as optional fallback.
2. **Discovery strategy expanded**: Plan assumed factory would be deployed by the ALVA deployer. In reality, it was deployed by a different address. Added deployer interaction scanning (not just deployment scanning) to find it.
3. **No 4byte.directory matches**: The custom selectors on `0x367e` (the subscription/config contract, not the factory) aren't in the 4byte directory, confirming they're Alvara-specific.

## Known Issues

- Without an Etherscan API key, the Blockscout API is slower (300ms rate limit vs 210ms). Discovery takes ~105s. With a key, Etherscan V2 would be faster.
- The verified ABI is from Blockscout's smart-contract endpoint. If Alvara upgrades the implementation, the cached ABI will be stale. T02 should re-fetch or verify.

## Files Created/Modified

- `package.json` — Project manifest with viem, tsx, typescript, dotenv
- `tsconfig.json` — TypeScript config targeting ES2022/NodeNext
- `.env.example` — Env var template (BASESCAN_API_KEY, PRIVATE_KEY)
- `.gitignore` — Ignoring node_modules, .env, dist, logs
- `src/config/chains.ts` — Base chain config, public client factory, known addresses, proxy slot constants
- `src/utils/basescan.ts` — Block explorer API helper (Blockscout primary, Etherscan V2 fallback) with rate limiting and retries
- `src/utils/proxy.ts` — EIP-1967 proxy detection utility
- `scripts/discover-factory.ts` — Factory discovery script with multi-signal scoring
- `src/config/discovered-contracts.json` — Discovered factory address, verified ABI (93 entries), proxy info, related contracts

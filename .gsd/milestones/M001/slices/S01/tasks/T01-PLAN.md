---
estimated_steps: 5
estimated_files: 9
skills_used: []
---

# T01: Scaffold project and discover Alvara factory contract on Base

**Slice:** S01 — Alvara Factory Discovery & BSKT Proof
**Milestone:** M001

## Description

The repository is completely empty — no package.json, no source files. This task creates the TypeScript project foundation and writes the factory discovery script that looks up Alvara's BSKT factory contract address from public on-chain data via Basescan.

The discovery approach:
1. Start from the known ALVA token on Base (`0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`), find its deployer via Basescan
2. Enumerate that deployer's other contract creations to find the factory
3. Alternatively, find any existing BSKT on Base from Alvara's leaderboard, trace its creation tx back to the factory
4. Decode factory function signatures from the creation tx calldata
5. Check EIP-1967 proxy storage slots

The factory address and reconstructed ABI are persisted to a JSON config file that T02 and all downstream slices consume.

**Key context for executor:**
- ALVA token on Base: `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`
- ERC-7621 interface ID: `0xc9c80f73`
- EIP-1967 implementation slot: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
- EIP-1967 admin slot: `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`
- Basescan API: `https://api.basescan.org/api` (free tier: 5 calls/sec)
- Base RPC: use viem's built-in `base` chain definition or public RPC `https://mainnet.base.org`
- Alvara's contracts are likely upgradeable proxies (launched on ETH first, deployed to Base)
- Decision D002: discover from public on-chain data, no team outreach needed — Alvara's contracts are public, we're just finding and using them normally

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Basescan API | Retry 3x with exponential backoff, then exit with clear error | 10s timeout per request, retry once | Log raw response, exit non-zero |
| Base RPC (viem) | Retry 2x, fall back to alternative public RPC | 15s timeout, retry once | Log raw response, exit non-zero |

## Steps

1. **Initialize project:** Create `package.json` with `typescript`, `tsx`, `viem`, `dotenv` as dependencies. Create `tsconfig.json` targeting ES2022/NodeNext. Create `.env.example` with `BASESCAN_API_KEY` and `PRIVATE_KEY` placeholders. Add `.env` to `.gitignore`.

2. **Create chain config module (`src/config/chains.ts`):** Export Base chain config using viem's built-in `base` chain. Export a public client factory function. Export known addresses (ALVA token, common Base tokens like WETH/USDC with their Base addresses).

3. **Create Basescan API helper (`src/utils/basescan.ts`):** Functions for: `getTransactionsByAddress(address, options)` — returns tx list; `getContractCreationTxs(address)` — returns contract creation info; `getContractABI(address)` — attempts to get verified ABI; `getInternalTxs(txHash)` — returns internal transactions. All functions handle rate limiting (100ms delay between calls), retry on 429, and return typed results. Use standard `fetch` — no extra HTTP library needed.

4. **Create proxy detection utility (`src/utils/proxy.ts`):** Function `detectProxy(client, address)` that reads EIP-1967 implementation and admin storage slots via `client.getStorageAt()`. Returns `{ isProxy: boolean, implementationAddress?: string, adminAddress?: string }`.

5. **Write discovery script (`scripts/discover-factory.ts`):** The main discovery logic:
   - Step A: Get the ALVA token's deployer address from Basescan (contract creation tx for `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`)
   - Step B: List all contracts deployed by that address on Base
   - Step C: For each deployed contract, check if it has function selectors consistent with a factory (e.g., `createBasket`, `create`, or similar patterns in its transaction history)
   - Step D: When a factory candidate is found, get a recent creation transaction, decode the calldata to extract function signature and parameter types using viem's `decodeFunctionData` (with the 4-byte selector) and `parseAbi`
   - Step E: Run proxy detection on the factory address
   - Step F: Write results to `src/config/discovered-contracts.json` with structure: `{ factoryAddress, implementationAddress?, isProxy, abi: [...], deployer, discoveredAt, chainId }`
   - Log structured JSON at each phase to stdout
   - Exit 0 on success, non-zero on failure with error JSON on stderr

## Must-Haves

- [ ] npm project initializes and `npx tsx` can execute TypeScript files
- [ ] Basescan API helper handles rate limiting and retries
- [ ] Discovery script finds the ALVA deployer and enumerates their Base contracts
- [ ] Factory address identified from deployment patterns or creation tx analysis
- [ ] ABI reconstructed with at least the creation function signature and parameter types
- [ ] Proxy detection reports EIP-1967 slot contents
- [ ] `src/config/discovered-contracts.json` contains all findings in machine-readable format

## Verification

- `npm install` completes without errors
- `npx tsx scripts/discover-factory.ts` exits 0 and prints JSON containing a `factoryAddress` field with a valid `0x`-prefixed 40-hex-char address
- `cat src/config/discovered-contracts.json` contains `factoryAddress`, `abi` (non-empty array), `isProxy` (boolean), and `chainId` (8453 for Base)

## Inputs

- `.gsd/milestones/M001/slices/S01/S01-RESEARCH.md` — discovery strategy, known addresses, proxy detection approach
- `.gsd/DECISIONS.md` — D002 confirms on-chain discovery approach

## Expected Output

- `package.json` — project manifest with TypeScript, viem, dotenv dependencies
- `tsconfig.json` — TypeScript configuration
- `.env.example` — env var template (BASESCAN_API_KEY, PRIVATE_KEY)
- `.gitignore` — ignoring node_modules, .env, dist
- `src/config/chains.ts` — Base chain config, public client factory, known token addresses
- `src/utils/basescan.ts` — Basescan API helper with rate limiting
- `src/utils/proxy.ts` — EIP-1967 proxy detection utility
- `scripts/discover-factory.ts` — factory discovery script
- `src/config/discovered-contracts.json` — discovered factory address, ABI, proxy info

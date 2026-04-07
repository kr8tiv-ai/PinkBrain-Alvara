---
estimated_steps: 5
estimated_files: 6
skills_used: []
---

# T02: Create BSKT on Base via factory and verify ERC-7621 compliance

**Slice:** S01 — Alvara Factory Discovery & BSKT Proof
**Milestone:** M001

## Description

Using the factory address and ABI discovered in T01 (persisted in `src/config/discovered-contracts.json`), this task writes the BSKT creation script and ERC-7621 verification module. This calls the factory's public interface to create a basket — the same interface any user interacts with through Alvara's frontend.

The creation flow (from Alvara docs): User sends ETH to factory -> ETH split by allocation weights -> each portion swapped to constituent tokens via DEX -> tokens deposited into new BSKT contract -> LP tokens minted to creator -> management NFT minted to creator. All in one transaction.

**Strategy for MEV protection integration:**
1. First attempt: call the factory directly with the discovered ABI. If creation functions accept swap route data as optional params, try without them.
2. If it reverts with a signature error: this means the factory requires Alvara's backend to sign swap routes (an MEV protection feature for users). Analyze 3-5 recent successful creation transactions on Basescan to understand the signing flow and document a clean integration path.
3. Document all MEV integration findings in `src/config/mev-findings.json` regardless of outcome — this data is valuable for later work.

Both outcomes (direct creation works OR MEV signing flow documented) are valid proof for this slice. The MEV protection is a legitimate user-protection feature, not a barrier — we just need to understand how to work with it.

**Key context for executor:**
- Factory address and ABI: read from `src/config/discovered-contracts.json` (T01 output)
- Constituent token candidates on Base: WETH (`0x4200000000000000000000000000000000000006`), USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Minimum seed: 0.1 ETH
- ERC-7621 interface ID: `0xc9c80f73`
- ERC-173 ownership: `owner()` function
- Wallet private key: from `PRIVATE_KEY` env var

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Factory contract call | Capture revert reason, analyze for MEV signing requirements, document in mev-findings.json | 60s timeout (on-chain tx may be slow) | Log raw tx receipt, attempt decode |
| Base RPC (viem) | Retry 2x with backoff | 15s per RPC call | Log raw response |
| Basescan (for MEV calldata analysis) | Retry 3x | 10s timeout | Log raw, continue with available data |

## Negative Tests

- **Malformed inputs**: Verify script handles invalid BSKT address (non-checksummed, wrong length, zero address) gracefully with clear error
- **Error paths**: Creation script captures and decodes revert reasons from factory call; verify script handles non-ERC7621 contract address
- **Boundary conditions**: Verify script checks for zero totalSupply, empty constituents array

## Steps

1. **Create factory interaction module (`src/alvara/factory.ts`):** Load discovered contracts config. Build typed viem contract instance from the factory ABI. Export `createBasket(client, params)` function that takes: wallet client, constituent tokens, weights (basis points summing to 10000), and seed value in ETH. The function sends the transaction, waits for receipt, and extracts the new BSKT address from either return value or emitted events. Log structured JSON at each phase.

2. **Write creation script (`scripts/create-bskt.ts`):** Load private key from env. Create wallet client on Base. Define a simple 2-token basket: 50% WETH / 50% USDC (weights: [5000, 5000]). Call factory via the module from step 1 with 0.1 ETH seed. On success: log BSKT address and tx hash. On revert: capture revert data, decode if possible, then fall back to MEV analysis (step 3). Always write creation results to stdout as structured JSON.

3. **Handle MEV protection analysis path:** If creation reverts with a signature-related error: (a) Use Basescan API to fetch 3-5 recent successful transactions TO the factory address. (b) Decode each tx's calldata to understand what parameters the frontend sends — these likely include backend-signed swap routes. (c) Compare parameter patterns across transactions to understand the signing flow. (d) Write all findings to `src/config/mev-findings.json`: `{ mevRequired: boolean, signingParams: [...], sampleTxHashes: [...], observedDeadlines: [...], recommendation: string }`.

4. **Create ERC-7621 read module (`src/alvara/erc7621.ts`):** Typed read-only functions using viem: `supportsInterface(client, address, interfaceId)`, `getConstituents(client, address)`, `getWeight(client, address, token)`, `getReserve(client, address, token)`, `totalSupply(client, address)`, `totalBasketValue(client, address)`, `owner(client, address)`. Each function returns a typed result. Export the ERC-7621 ABI as a constant (from the EIP spec in the research doc).

5. **Write verification script (`scripts/verify-bskt.ts`):** Takes a BSKT contract address as CLI argument. Runs a full verification suite: (a) Check `supportsInterface(0xc9c80f73)` returns true. (b) Call `getConstituents()` and verify non-empty arrays. (c) Check each constituent's weight sums to 10000. (d) Verify `totalSupply() > 0`. (e) Call `owner()` and verify it matches the creator wallet. (f) Output a structured JSON report: `{ verified: boolean, bsktAddress, interfaceSupported, constituents: [...], totalSupply, owner, checks: { name, passed, value }[] }`. Exit 0 if all checks pass, exit 1 if any fail.

## Must-Haves

- [ ] Factory module correctly loads discovered ABI and creates typed contract instance
- [ ] Creation script sends real transaction to Base factory with proper gas estimation
- [ ] On success: BSKT address and tx hash captured and logged
- [ ] On MEV requirement: revert reason captured, recent txs analyzed, integration path documented
- [ ] ERC-7621 module implements all key view functions from the spec
- [ ] Verification script runs full compliance check and outputs structured JSON report
- [ ] Private key never appears in logs or output — only public addresses and tx hashes

## Verification

- `npx tsx scripts/create-bskt.ts` exits 0 with JSON containing `bsktAddress` and `txHash` fields, OR exits 1 with `src/config/mev-findings.json` populated with `mevRequired: true` and non-empty `signingParams`
- If BSKT created: `npx tsx scripts/verify-bskt.ts <address>` exits 0 with JSON containing `verified: true`
- `cat src/config/mev-findings.json` exists and contains structured observations (even on success — document that MEV was NOT required)

## Observability Impact

- Signals added/changed: creation script logs `{ phase, action, txHash?, error?, revertReason? }` to stdout; MEV analysis logs decoded calldata patterns
- How a future agent inspects this: read `src/config/mev-findings.json` for MEV integration details; read creation script stdout for tx results
- Failure state exposed: revert reason decoded and logged, MEV signing parameter structure documented, sample tx hashes for manual inspection

## Inputs

- `src/config/discovered-contracts.json` — factory address and ABI from T01
- `src/config/chains.ts` — Base chain config and known token addresses from T01
- `src/utils/basescan.ts` — Basescan API helper from T01
- `src/utils/proxy.ts` — proxy detection from T01
- `package.json` — project dependencies from T01

## Expected Output

- `src/alvara/factory.ts` — typed factory interaction module
- `src/alvara/erc7621.ts` — ERC-7621 read-only interface module
- `scripts/create-bskt.ts` — BSKT creation script with MEV integration fallback
- `scripts/verify-bskt.ts` — ERC-7621 compliance verification script
- `src/config/mev-findings.json` — MEV integration observations (always written)

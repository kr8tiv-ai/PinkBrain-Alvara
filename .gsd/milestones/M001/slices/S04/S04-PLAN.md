# S04: Jupiter Swap & Holder Resolution

**Goal:** Prove Jupiter SOL→USDC swap and top-100 holder resolution as independent subsystem modules with unit tests and CLI proof scripts.
**Demo:** After this: SOL swapped to USDC via Jupiter and top 100 holders resolved for an arbitrary SPL token mint

## Tasks
- [x] **T01: Built Jupiter Ultra V3 swap module with 24 passing unit tests and live CLI estimate proving 0.01 SOL → 0.80 USDC quote via Jupiter API** — Create the Jupiter swap subsystem that proves R004 (swap SOL reflections to USDC via Jupiter). Follows the established deBridge pattern: types file → API module with structured logging and fetchWithTimeout → unit tests with mocked fetch → CLI proof script with --estimate-only and --amount flags.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Jupiter Ultra V3 API (`api.jup.ag`) | Throw with HTTP status + response body | AbortController timeout after 15s, throw descriptive error | Validate response shape before returning, throw on missing `transaction` or `requestId` fields |
| Solana RPC (for VersionedTransaction) | Not called during order/execute — Jupiter handles submission | N/A for module (Jupiter manages RPC internally) | N/A |

## Negative Tests

- **Malformed inputs**: zero amount, negative amount, empty mint address, non-base58 address
- **Error paths**: HTTP 400 (bad request), HTTP 429 (rate limit), HTTP 500 (server error), network timeout, response missing required fields
- **Boundary conditions**: minimum swap amount, amount as string vs number

## Steps

1. Add `WRAPPED_SOL` mint address and `SPL_TOKEN_PROGRAM_ID` to `SOLANA_KNOWN_ADDRESSES` in `src/config/solana.ts`
2. Create `src/jupiter/types.ts` with TypeScript interfaces: `JupiterOrderRequest`, `JupiterOrderResponse` (contains `transaction` base64 string, `requestId`, type/inputMint/outputMint/inAmount/outAmount), `JupiterExecuteRequest`, `JupiterExecuteResponse` (contains `status`, `signature`, `error`)
3. Create `src/jupiter/swap.ts` with:
   - `log()` structured logger (module: 'jupiter')
   - `fetchWithTimeout()` (same pattern as deBridge)
   - `getSwapOrder(inputMint, outputMint, amount, taker)` → calls `GET /ultra/v1/order` with query params, returns `JupiterOrderResponse`
   - `executeSwap(signedTransaction, requestId)` → calls `POST /ultra/v1/execute` with JSON body `{signedTransaction, requestId}`, returns `JupiterExecuteResponse`
   - `swapSolToUsdc(amountLamports, wallet, connection)` → high-level helper: getSwapOrder → deserialize base64 VersionedTransaction → sign with wallet → serialize to base64 → executeSwap. Returns `{signature, inAmount, outAmount}`
   - Input validation on all public functions (amount > 0, valid addresses)
   - **Critical**: Jupiter returns base64-encoded VersionedTransaction. Do NOT inject ComputeBudget instructions (Jupiter handles internally). Sign as-is.
4. Create `tests/jupiter-swap.test.ts` with mocked fetch:
   - Test `getSwapOrder` builds correct URL and parses response
   - Test `executeSwap` sends correct POST body and parses response
   - Test input validation (zero amount, empty address)
   - Test error handling (HTTP 400, 500, timeout, malformed response)
   - Test `swapSolToUsdc` orchestration with mocked order + execute
5. Create `scripts/jupiter-swap.ts` CLI proof script:
   - `--estimate-only` mode: calls `getSwapOrder` and prints quote (no wallet needed)
   - `--amount <lamports>` flag (default: 10000000 = 0.01 SOL)
   - Full swap mode: requires `SOL_PRIVATE_KEY` env var, calls `swapSolToUsdc`
   - Structured logging + human-readable summary output
6. Add `jupiter-swap` and `jupiter-estimate` scripts to `package.json`
  - Estimate: 1h
  - Files: src/config/solana.ts, src/jupiter/types.ts, src/jupiter/swap.ts, tests/jupiter-swap.test.ts, scripts/jupiter-swap.ts, package.json
  - Verify: npx vitest run tests/jupiter-swap.test.ts && npx tsx scripts/jupiter-swap.ts --estimate-only --amount 10000000
- [ ] **T02: Build holder resolution module with dual-strategy RPC, unit tests, and CLI script** — Create the holder resolution subsystem that proves R013 (query top 100 holders of any SPL token mint). Implements two strategies: `getProgramAccounts` with SPL Token filters (universal fallback) and Helius DAS `getTokenAccounts` (preferred when Helius RPC detected). Returns sorted holder list with owner addresses, amounts, and percentage shares.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Solana RPC `getProgramAccounts` | Throw with RPC error message and code | Connection timeout (60s default), throw descriptive error | Validate account data length is 165 bytes, skip malformed accounts with warning log |
| Helius DAS `getTokenAccounts` | Fall back to `getProgramAccounts` strategy with warning log | Fall back to `getProgramAccounts` strategy | Validate response has `token_accounts` array, fall back on unexpected shape |

## Negative Tests

- **Malformed inputs**: empty mint address, invalid base58 mint, count of 0, count > 10000
- **Error paths**: RPC connection refused, getProgramAccounts disabled (HTTP 403/410), Helius 429 rate limit, malformed account data (< 165 bytes)
- **Boundary conditions**: token with 0 holders, token with < count holders, zero-balance accounts filtered, count=1

## Steps

1. Create `src/holders/types.ts` with:
   - `HolderInfo` interface: `{ owner: string; amount: bigint; percentage: number }`
   - `HolderResolutionResult` interface: `{ holders: HolderInfo[]; totalSupplyHeld: bigint; strategy: 'helius-das' | 'getProgramAccounts'; mint: string }`
2. Create `src/holders/resolve.ts` with:
   - `log()` structured logger (module: 'holders')
   - `isHeliusRpc(url)` — detect Helius RPC from URL (contains 'helius')
   - `resolveHoldersViaProgramAccounts(connection, mint, count)` — calls `connection.getProgramAccounts()` with SPL Token program ID, dataSize filter (165), memcmp filter at offset 0 for mint bytes. Parse each account: owner at bytes 32-63, amount at bytes 64-71 (u64 LE via `Buffer.readBigUInt64LE(64)`). Filter zero-balance. Sort descending. Take top `count`. Calculate percentage shares.
   - `resolveHoldersViaHelius(rpcUrl, mint, count)` — calls Helius DAS `getTokenAccounts` with mint filter, paginated (limit 1000 per page). Parse owner + amount. Sort descending. Take top `count`. Calculate percentages.
   - `getTopHolders(mint, count, connection?)` — main entry: if Helius detected, try Helius first with fallback to getProgramAccounts. Otherwise use getProgramAccounts directly. Input validation on mint (non-empty, 32-44 chars base58) and count (1-10000).
   - **Critical**: SPL Token account layout is 165 bytes. Mint at offset 0 (32 bytes), owner at offset 32 (32 bytes), amount at offset 64 (8 bytes u64 LE). Filter out zero-balance accounts before sorting.
3. Create `tests/holder-resolution.test.ts` with mocked RPC:
   - Test `resolveHoldersViaProgramAccounts` parses account data correctly (craft Buffer with known mint/owner/amount)
   - Test sorting is descending by amount
   - Test percentage calculation sums to ~100% (within rounding)
   - Test zero-balance accounts are filtered
   - Test count limiting (request 5, get 5 even if more exist)
   - Test input validation (empty mint, count=0)
   - Test `isHeliusRpc` detection
   - Test fallback from Helius to getProgramAccounts on error
4. Create `scripts/resolve-holders.ts` CLI proof script:
   - `--mint <address>` flag (required)
   - `--count <N>` flag (default: 100)
   - Uses `SOL_RPC_URL` env var (defaults to public mainnet)
   - Outputs table: rank, owner address (truncated), amount, percentage
   - Structured logging + human-readable summary
5. Add `resolve-holders` script to `package.json`
  - Estimate: 1h
  - Files: src/holders/types.ts, src/holders/resolve.ts, tests/holder-resolution.test.ts, scripts/resolve-holders.ts, package.json
  - Verify: npx vitest run tests/holder-resolution.test.ts && npx tsx scripts/resolve-holders.ts --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --count 20

# S02: deBridge Solana→Base Bridge Proof

**Goal:** Prove deBridge DLN API integration works for bridging USDC from Solana to Base, with typed client, Solana tx preparation, and executable bridge/status scripts.
**Demo:** After this: USDC bridged from Solana to Base via deBridge DLN API with verifiable tx hashes on both chains

## Tasks
- [x] **T01: Build deBridge API client, types, and Solana config with unit tests** — **Slice:** S02 — deBridge Solana→Base Bridge Proof
**Milestone:** M001

## Description

Build the typed foundation for deBridge integration: TypeScript interfaces for all API request/response shapes, a thin API client wrapping the DLN REST endpoints, Solana chain configuration following the existing `src/config/chains.ts` pattern, and vitest as the project's test framework. This task produces the core modules that T02 and T03 build on.

The deBridge DLN API is simple REST with query parameters — no SDK needed. The API client wraps three endpoints:
- `POST https://dln.debridge.finance/v1.0/dln/order/create-tx` — create bridge order (returns tx data)
- `GET https://stats-api.dln.trade/api/Transaction/{txHash}/orderIds` — get order ID from tx hash
- `GET https://stats-api.dln.trade/api/Orders/{orderId}` — get order status

Solana chain IDs for deBridge: `7565164`. Base chain ID: `8453`.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| deBridge DLN API (`dln.debridge.finance`) | Throw with HTTP status + response body in error message | 15s timeout, throw with timeout indicator | Validate response has required fields (`tx.data`, `estimation`), throw descriptive error if missing |
| deBridge Stats API (`stats-api.dln.trade`) | Throw with HTTP status + context (order ID or tx hash being queried) | 10s timeout, throw | Validate response structure, return null for 404 (order not found yet) |

## Negative Tests

- **Malformed inputs**: Empty/zero bridge amount returns descriptive error. Missing required fields in order input throw before making API call.
- **Error paths**: Test that non-200 API responses produce errors with HTTP status and body context. Test 404 from stats API returns null (order not yet indexed).
- **Boundary conditions**: Test amount formatting — atomic units (bigint string) vs human-readable. Verify chain ID constants match expected values.

## Steps

1. **Install dependencies**: Add `@solana/web3.js@^1.98`, `bs58@^6.0`, `vitest@^3.1` to the project. Add vitest config file. Add `"test": "vitest run"` script to package.json.

2. **Create `src/debridge/types.ts`**: Define TypeScript interfaces:
   - `DeBridgeChainId` — enum/const with `SOLANA = 7565164`, `BASE = 8453`, `ETHEREUM = 1`
   - `DeBridgeOrderInput` — `srcChainId`, `srcChainTokenIn` (token address), `srcChainTokenInAmount` (atomic units string), `dstChainId`, `dstChainTokenOut`, `dstChainTokenOutRecipient?` (optional for estimation), `prependOperatingExpenses` (boolean)
   - `DeBridgeOrderResponse` — `tx.data` (hex string), `tx.to`, `tx.value`, `estimation` (with `srcChainTokenIn`, `dstChainTokenOut` amounts and fees), `orderId`, `fixFee`, `userPoints`, `integratorPoints`
   - `DeBridgeOrderStatus` — `orderId`, `status` enum (`Created`, `Fulfilled`, `SentUnlock`, `ClaimedUnlock`, `Cancelled`), `fulfillTransactionHash?`, `sourceChainId`, `destinationChainId`
   - Export all types.

3. **Create `src/config/solana.ts`**: Solana chain configuration module:
   - `SOLANA_KNOWN_ADDRESSES` — `USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'`, `NATIVE_SOL: '11111111111111111111111111111111'`
   - `createSolanaConnection(rpcUrl?: string)` — factory that creates `@solana/web3.js Connection` with configurable RPC URL (default from `SOL_RPC_URL` env var, fallback to `https://api.mainnet-beta.solana.com`)
   - `loadSolanaKeypair(base58PrivateKey: string)` — decode base58 private key to `Keypair` using `bs58.decode()` then `Keypair.fromSecretKey()`

4. **Create `src/debridge/api.ts`**: deBridge DLN API client with 4 exported functions:
   - `createBridgeOrder(params: DeBridgeOrderInput): Promise<DeBridgeOrderResponse>` — builds URLSearchParams from input, POSTs to `/v1.0/dln/order/create-tx`, validates response has `tx.data` or `estimation`, returns typed response. Must set `prependOperatingExpenses=true` by default.
   - `getOrderIdByTxHash(txHash: string, chainId?: number): Promise<string | null>` — GETs from stats API, returns first order ID or null if not found
   - `getOrderStatus(orderId: string): Promise<DeBridgeOrderStatus>` — GETs from stats API, returns typed status
   - `waitForFulfillment(orderId: string, opts?: { maxAttempts?: number, intervalMs?: number }): Promise<DeBridgeOrderStatus>` — polls `getOrderStatus` every 5s (configurable), returns when status is `Fulfilled` or `ClaimedUnlock`, throws after max attempts (default 60 = 5 minutes)
   - All functions log structured JSON with phase, action, and relevant IDs. Never log private keys.

5. **Create `tests/debridge-api.test.ts`**: Unit tests using vitest:
   - Test `createBridgeOrder` builds correct URLSearchParams from input (mock fetch, inspect request URL and params)
   - Test `createBridgeOrder` throws on non-200 response with status and body in error
   - Test `getOrderIdByTxHash` returns null on 404
   - Test `getOrderStatus` parses valid status response correctly
   - Test chain ID constants match expected values
   - Test `DeBridgeOrderInput` validation — verify required fields are present
  - Estimate: 1h
  - Files: src/debridge/types.ts, src/debridge/api.ts, src/config/solana.ts, tests/debridge-api.test.ts, package.json, vitest.config.ts, .env.example
  - Verify: `npx tsc --noEmit` exits 0 AND `npx vitest run` exits 0 with all tests passing
- [x] **T02: Fixed 2 failing test assertions for hex validation order and verified all 37 tests pass with clean TypeScript compilation** — **Slice:** S02 — deBridge Solana→Base Bridge Proof
**Milestone:** M001

## Description

The deBridge API returns a hex-encoded Solana `VersionedTransaction` that needs several preparation steps before it can be signed and submitted to the Solana network. This task builds the Solana-side execution engine: deserialize the hex data, refresh the blockhash (the API-provided one may be stale), estimate compute units via simulation, set priority fee instructions, sign with the wallet keypair, and submit with confirmation.

Key constraints from research:
- The API returns `tx.data` as `"0x..."` hex — must strip `0x` prefix before `Buffer.from(hex, 'hex')`
- `VersionedTransaction.deserialize()` expects a `Uint8Array`
- Must replace `recentBlockhash` in the message before signing (30-second submission window)
- Compute unit simulation gives accurate gas estimation for priority fee calculation
- Use `confirmed` commitment level for fast feedback (not `finalized`)

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Solana RPC (`Connection`) | Throw with RPC error code + message. Include the method that failed (e.g., `simulateTransaction`, `sendRawTransaction`) | 30s timeout on send, throw with timeout context | Validate simulation result has `unitsConsumed`, fall back to default compute budget (200k units) if missing |
| Transaction deserialization | Throw with descriptive error if hex data is invalid or not a valid VersionedTransaction | N/A (local operation) | Validate the deserialized tx has a message with instructions before proceeding |

## Negative Tests

- **Malformed inputs**: Invalid hex string (odd length, non-hex chars) produces clear error. Empty hex string throws before attempting deserialization.
- **Error paths**: Simulation failure falls back to default compute budget rather than failing entirely. Send failure includes the Solana error logs from simulation.
- **Boundary conditions**: Transaction with no instructions detected and rejected before signing.

## Steps

1. **Create `src/debridge/solana-tx.ts`**: Implement two exported functions:
   - `prepareSolanaTransaction(connection: Connection, txDataHex: string, wallet: Keypair): Promise<VersionedTransaction>`:
     1. Strip `0x` prefix if present from `txDataHex`
     2. `Buffer.from(hex, 'hex')` → `VersionedTransaction.deserialize(buffer)`
     3. `connection.getLatestBlockhash('confirmed')` → replace `transaction.message.recentBlockhash`
     4. Simulate the transaction via `connection.simulateTransaction(tx)` to get `unitsConsumed`
     5. Create `ComputeBudgetProgram.setComputeUnitLimit({ units: unitsConsumed * 1.1 })` instruction
     6. Fetch recent priority fees via `connection.getRecentPrioritizationFees()`, compute median, create `ComputeBudgetProgram.setComputeUnitPrice({ microLamports })` instruction
     7. Note: For VersionedTransactions, compute budget instructions may need to be added via `TransactionMessage.decompile` → add instructions → `recompile` → re-sign, OR the API may already include them. Check simulation result first — if compute budget is already set, skip adding new ones.
     8. Sign with `wallet`: `transaction.sign([wallet])`
     9. Return the signed transaction
   - `sendAndConfirmBridgeTransaction(connection: Connection, transaction: VersionedTransaction): Promise<string>`:
     1. `connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false })`
     2. `connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')`
     3. Log structured JSON: `{ phase: 'solana_tx', action: 'confirmed', signature, slot }`
     4. Return the signature string

2. **Create `tests/solana-tx.test.ts`**: Unit tests:
   - Test hex prefix stripping: `"0xabcd"` → `"abcd"`, `"abcd"` → `"abcd"`
   - Test that empty hex string throws descriptive error
   - Test that non-hex characters in input throw descriptive error

3. **Verify everything compiles**: Run `npx tsc --noEmit` and `npx vitest run` to confirm both the new module and its tests work with the T01 outputs.
  - Estimate: 45m
  - Files: src/debridge/solana-tx.ts, tests/solana-tx.test.ts
  - Verify: `npx tsc --noEmit` exits 0 AND `npx vitest run` exits 0
- [x] **T03: Created bridge/status scripts and proved deBridge DLN API connectivity with live Solana→Base USDC estimation returning non-zero amounts** — **Slice:** S02 — deBridge Solana→Base Bridge Proof
**Milestone:** M001

## Description

This is the integration proof task. Wire the deBridge API client and Solana tx utilities into two executable scripts, then run a dry-run estimation against the live deBridge API to prove connectivity.

`bridge-sol-to-base.ts` has two modes:
- **Estimate-only** (`--estimate-only`): Calls `createBridgeOrder` without a recipient address. Returns estimated input/output amounts and fees. No wallet needed. This is the contract-level proof that the API client works with the real deBridge endpoint.
- **Full bridge** (default): Requires `SOL_PRIVATE_KEY`, `SOL_RPC_URL`, `BASE_WALLET_ADDRESS` env vars. Creates order → prepares Solana tx → signs → sends → polls for fulfillment → logs both chain tx hashes.

`check-bridge-status.ts` is a standalone diagnostic tool that queries order status by order ID or Solana tx hash.

The estimate-only dry run is the slice's integration verification — it proves the API client constructs valid requests and parses real responses from deBridge.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| deBridge DLN API (estimate) | Print error with HTTP status + body, exit 1 | 15s timeout, print timeout error, exit 1 | Validate response has `estimation` field, print raw response for debugging if malformed |
| deBridge DLN API (full bridge) | Print error with context (phase, last successful step), exit 1 | 15s for order creation, 30s for tx send, 5min for fulfillment polling | Log partial progress (order ID, tx hash) so human can resume debugging |
| Solana RPC (full bridge) | Print RPC error with method name, exit 1 | 30s timeout, suggest checking RPC URL | N/A |
| Environment variables (full bridge) | Print which env vars are missing with example format, exit 1 | N/A | Validate key format (base58 for SOL_PRIVATE_KEY, 0x-prefixed for BASE_WALLET_ADDRESS) |

## Steps

1. **Create `scripts/bridge-sol-to-base.ts`**:
   - Parse CLI args: `--estimate-only` flag, `--amount` (USDC amount in human units, default `0.20`), `--help`
   - Load `dotenv/config`
   - **Estimate-only mode**: Call `createBridgeOrder` with: `srcChainId: 7565164`, `srcChainTokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'` (Solana USDC), `srcChainTokenInAmount` (convert human amount to 6-decimal atomic units), `dstChainId: 8453`, `dstChainTokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'` (Base USDC), no `dstChainTokenOutRecipient`, `prependOperatingExpenses: true`. Log estimation. Exit 0.
   - **Full bridge mode**: Validate env vars → load keypair → create connection → create order → prepare tx → send → poll → log results.
   - All console output uses structured JSON logging. Never log `SOL_PRIVATE_KEY`.

2. **Create `scripts/check-bridge-status.ts`**:
   - Parse CLI args: `--order-id <id>` or `--tx-hash <hash>` (one required), `--help`
   - Query status and print: order ID, status, source/destination chains, fulfillment tx hash, explorer URLs.

3. **Update `package.json`**: Add npm scripts: `bridge`, `bridge-status`, `bridge-estimate`.

4. **Run dry-run estimation**: Execute `npx tsx scripts/bridge-sol-to-base.ts --estimate-only` and verify it returns a valid estimation from the live deBridge API.
  - Estimate: 45m
  - Files: scripts/bridge-sol-to-base.ts, scripts/check-bridge-status.ts, package.json
  - Verify: `npx tsc --noEmit` exits 0 AND `npx tsx scripts/bridge-sol-to-base.ts --estimate-only` exits 0 and prints estimation with non-zero amounts

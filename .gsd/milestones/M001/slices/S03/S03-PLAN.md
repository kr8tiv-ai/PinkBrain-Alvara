# S03: Bags SDK Fee Share & Reflection Claiming

**Goal:** Prove Bags SDK can query fee share admin status, update fee share config to redirect claimers to a treasury wallet, and claim accumulated fees — all programmatically via the official SDK and REST API.
**Demo:** After this: Fee share for a test token redirected to a treasury wallet and accumulated fees claimed via Bags SDK

## Tasks
- [x] **T01: Install @bagsfm/bags-sdk, create src/bags/ client wrapper with types, and 14 passing unit tests** — Install the @bagsfm/bags-sdk package, create the src/bags/ module with client initialization and type definitions, and write unit tests proving SDK instantiation works.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| npm registry | Retry install once, fail with clear message | 60s timeout on npm install | Check package.json has correct version after install |
| Bags API /ping | Return structured error with HTTP status | 10s fetch timeout, throw with context | Validate response has `message` field |

## Steps

1. Run `npm install @bagsfm/bags-sdk` and verify it appears in `package.json` dependencies
2. Create `src/bags/types.ts` with TypeScript interfaces for:
   - `BagsClientConfig` (apiKey, rpcUrl?, commitment?)
   - `BagsFeeShareAdmin` (wallet, tokenMints)
   - `BagsClaimablePosition` (tokenMint, totalClaimableLamportsUserShare, isCustomFeeVault, isMigrated, customFeeVaultClaimerSide?)
   - `BagsClaimTransaction` (base64-encoded VersionedTransaction, metadata)
   - `BagsFeeShareUpdateConfig` (baseMint, claimersArray, basisPointsArray, payer, additionalLookupTables?)
   - `BagsApiResponse<T>` generic wrapper with success/error discrimination
3. Create `src/bags/client.ts`:
   - Import `BagsSDK` from `@bagsfm/bags-sdk`
   - Export `createBagsClient(config: BagsClientConfig)` factory function
   - Initialize SDK with API key, Solana connection from `src/config/solana.ts`, commitment level
   - Export a `log()` helper matching the debridge pattern: `{ ts, module: 'bags', phase, action, ...data }`
   - Export `fetchWithTimeout()` for direct REST calls (reuse debridge pattern)
   - Add `BAGS_API_BASE` constant: `https://public-api-v2.bags.fm/api/v1`
   - Add `pingApi(apiKey: string)` function that calls `GET /ping` with `x-api-key` header to validate the key
4. Create `tests/bags-client.test.ts`:
   - Mock `globalThis.fetch` following the pattern in `tests/debridge-api.test.ts`
   - Test: `pingApi` sends correct headers and returns parsed response
   - Test: `pingApi` throws on timeout
   - Test: `pingApi` throws on non-200 response with status code in error
   - Test: `createBagsClient` returns an SDK instance (mock the SDK constructor)
   - Test: missing API key throws descriptive error
5. Verify: `npx vitest run tests/bags-client.test.ts` passes

## Must-Haves

- [ ] `@bagsfm/bags-sdk` in package.json dependencies
- [ ] `src/bags/types.ts` exports all listed interfaces
- [ ] `src/bags/client.ts` exports `createBagsClient`, `pingApi`, `log`, `fetchWithTimeout`, `BAGS_API_BASE`
- [ ] `tests/bags-client.test.ts` has 5+ test cases covering happy path and error paths
- [ ] All tests pass with mocked fetch — zero real network calls
- [ ] Structured JSON logging matches debridge pattern

## Verification

- `npx vitest run tests/bags-client.test.ts` — all tests pass
- `grep -q '@bagsfm/bags-sdk' package.json` — SDK installed
  - Estimate: 45m
  - Files: package.json, src/bags/types.ts, src/bags/client.ts, tests/bags-client.test.ts
  - Verify: npx vitest run tests/bags-client.test.ts
- [x] **T02: Built fee-share admin query/update and fee claiming modules with 28 passing tests covering happy paths, input validation, error wrapping, and on-chain confirmation** — Build the two core business logic modules — fee share admin query/update and fee claiming — following the patterns established in T01. This is the heart of R002.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| GET /fee-share/admin/list | Return empty admin list with warning log | 10s timeout, throw with endpoint context | Validate response is array, return empty on unexpected shape |
| POST /fee-share/admin/update-config | Throw with HTTP status + response body | 15s timeout (transaction building is heavier) | Validate `transactions` array exists in response |
| sdk.fee.getAllClaimablePositions | Throw with wallet context | 15s timeout | Validate positions array, warn on unexpected fields |
| sdk.fee.getClaimTransactions | Throw with wallet+mint context | 15s timeout | Validate transactions array with base64 check |

## Negative Tests

- **Malformed inputs**: empty wallet address, invalid token mint, null basisPointsArray
- **Error paths**: 401 unauthorized (bad API key), 429 rate limited (check retry-after), 500 server error
- **Boundary conditions**: basisPointsArray not summing to 10000, empty claimers array, 0 claimable positions, >7 claimers requiring lookup tables

## Steps

1. Create `src/bags/fee-share.ts`:
   - Import `log`, `fetchWithTimeout`, `BAGS_API_BASE` from `./client.js`
   - `getAdminTokenList(apiKey: string, wallet: string): Promise<string[]>` — calls `GET /fee-share/admin/list?wallet={wallet}` with `x-api-key` header. Returns array of token mint addresses where the wallet is fee share admin. Log rate limit headers from response.
   - `getClaimablePositions(apiKey: string, wallet: string): Promise<BagsClaimablePosition[]>` — calls the SDK's `fee.getAllClaimablePositions(wallet)` or falls back to direct REST `GET /fee/claimable-positions?wallet={wallet}`. Returns structured positions.
   - `buildUpdateConfigTransaction(apiKey: string, config: BagsFeeShareUpdateConfig): Promise<string[]>` — calls `POST /fee-share/admin/update-config` with JSON body `{ baseMint, claimersArray, basisPointsArray, payer, additionalLookupTables }`. Validates basisPointsArray sums to 10000 before calling API. Returns array of base64-encoded VersionedTransaction strings.
   - Input validation on all functions: non-empty wallet (base58 format check), non-empty apiKey, valid mint addresses.

2. Create `src/bags/fee-claim.ts`:
   - Import `log`, `fetchWithTimeout`, `BAGS_API_BASE` from `./client.js`
   - `getClaimTransactions(apiKey: string, wallet: string, tokenMint: string): Promise<string[]>` — calls the SDK's `fee.getClaimTransactions(wallet, tokenMint)` or falls back to REST. Returns base64-encoded VersionedTransaction strings.
   - `signAndSendClaimTransactions(connection: Connection, keypair: Keypair, transactions: string[]): Promise<string[]>` — deserializes base64 VersionedTransactions, signs with keypair, sends via connection, waits for confirmation. Returns array of tx signature strings. Logs each tx hash as it confirms. Handles blockhash expiry by checking `lastValidBlockHeight`.
   - Each function logs entry/exit with structured JSON (phase: 'claim', action: 'get-transactions' | 'sign-send').

3. Create `tests/bags-fee-share.test.ts` (covers both modules):
   - Mock `globalThis.fetch`
   - **Admin list tests**: happy path returns mint array, empty wallet throws, 401 returns descriptive error, rate limit headers logged
   - **Update config tests**: happy path returns transaction array, basisPoints not summing to 10000 throws before API call, empty claimers throws, response missing `transactions` field throws
   - **Claimable positions tests**: happy path returns typed positions, empty result returns empty array, API error includes HTTP status
   - **Claim transactions tests**: happy path returns base64 strings, empty token mint throws, 429 rate limit error includes retry-after
   - **signAndSendClaimTransactions tests**: mock Connection.sendRawTransaction and confirmTransaction, verify tx signatures returned, verify timeout handling

4. Verify: `npx vitest run tests/bags-fee-share.test.ts` passes

## Must-Haves

- [ ] `src/bags/fee-share.ts` exports `getAdminTokenList`, `getClaimablePositions`, `buildUpdateConfigTransaction`
- [ ] `src/bags/fee-claim.ts` exports `getClaimTransactions`, `signAndSendClaimTransactions`
- [ ] Basis points validation (must sum to 10000) enforced client-side before API call
- [ ] Rate limit headers captured and logged on every API response
- [ ] All functions have input validation with descriptive error messages
- [ ] Tests cover happy paths, error responses (401, 429, 500), and input validation
- [ ] Structured JSON logging on all API calls matching `module: 'bags'` pattern

## Verification

- `npx vitest run tests/bags-fee-share.test.ts` — all tests pass
- `npx vitest run` — full suite passes (no regressions in debridge tests)
  - Estimate: 1h30m
  - Files: src/bags/fee-share.ts, src/bags/fee-claim.ts, tests/bags-fee-share.test.ts
  - Verify: npx vitest run tests/bags-fee-share.test.ts && npx vitest run
- [x] **T03: Created scripts/bags-fee-share.ts CLI proof with 6 mock response shapes in dry-run mode, env validation in live mode, and structured JSON output throughout** — Create the CLI script that proves the slice demo: query admin status, update fee share config, query claimable positions, and claim fees. Supports --dry-run mode for testing without a live API key. Update .env.example with BAGS_API_KEY.

## Steps

1. Update `.env.example` — add `BAGS_API_KEY=` with a comment explaining where to get it (`dev.bags.fm`)
2. Create `scripts/bags-fee-share.ts`:
   - Parse CLI args: `--dry-run` (use mock data instead of real API), `--wallet <address>` (override default), `--token-mint <address>` (target token), `--treasury <address>` (treasury wallet to add as claimer), `--claim` (actually sign and send claim transactions)
   - Load env: `dotenv/config`, read `BAGS_API_KEY`, `SOL_PRIVATE_KEY`, `SOL_RPC_URL`
   - In dry-run mode: print mock response shapes showing what each API call would return (admin list, claimable positions, update-config transaction, claim transactions). Exit 0.
   - In live mode:
     a. Call `pingApi(apiKey)` to validate the key
     b. Call `getAdminTokenList(apiKey, wallet)` — log the mints where wallet is admin
     c. Call `getClaimablePositions(apiKey, wallet)` — log positions with claimable amounts
     d. If `--treasury` provided: call `buildUpdateConfigTransaction(apiKey, { baseMint: tokenMint, claimersArray: [wallet, treasury], basisPointsArray: [5000, 5000], payer: wallet })` — log the transaction payload (don't sign unless --claim is passed)
     e. If `--claim` provided: call `getClaimTransactions(apiKey, wallet, tokenMint)`, then `signAndSendClaimTransactions(connection, keypair, txs)` — log tx hashes
   - All output is structured JSON to stdout (consistent with other scripts)
   - Error handling: catch at top level, log structured error with phase, exit 1
3. Add npm script to `package.json`: `"bags-fee-share": "tsx scripts/bags-fee-share.ts"`
4. Verify: `npx tsx scripts/bags-fee-share.ts --dry-run` exits 0 with valid JSON output showing all API response shapes
5. Verify: `npx vitest run` — full test suite still passes (no regressions)

## Must-Haves

- [ ] `scripts/bags-fee-share.ts` runs in --dry-run mode without any env vars set
- [ ] Dry-run output shows realistic mock shapes for: admin list, claimable positions, update-config tx, claim tx
- [ ] Live mode validates BAGS_API_KEY is set before making API calls
- [ ] Live mode with --claim validates SOL_PRIVATE_KEY is set before signing
- [ ] All output is structured JSON (one JSON object per line)
- [ ] npm script `bags-fee-share` added to package.json
- [ ] .env.example updated with BAGS_API_KEY

## Verification

- `npx tsx scripts/bags-fee-share.ts --dry-run` exits 0 with JSON output
- `npx vitest run` — full test suite passes
  - Estimate: 45m
  - Files: scripts/bags-fee-share.ts, package.json, .env.example
  - Verify: npx tsx scripts/bags-fee-share.ts --dry-run && npx vitest run

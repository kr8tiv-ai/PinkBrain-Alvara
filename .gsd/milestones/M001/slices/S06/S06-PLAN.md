# S06: Outbound Subsystem Integration

**Goal:** Wire Bags fee claiming, Jupiter swap, protocol fee deduction, and deBridge bridge into a single orchestrated outbound pipeline with state persistence via the fund repository.
**Demo:** After this: End-to-end outbound flow: claim reflection → Jupiter swap to USDC → deBridge bridge to Base → USDC confirmed on Base

## Tasks
- [x] **T01: Built outbound pipeline orchestrating claim→swap→protocol fee deduction→bridge with full DB state tracking and structured logging** — Create the core outbound pipeline module that orchestrates claim → swap → protocol fee deduction → bridge as a single function, with pipeline run state tracking and transaction recording at each phase.

## Steps

1. Create `src/pipeline/types.ts` with `OutboundPipelineResult` interface (pipelineRunId, txHashes map by phase, amountClaimed, amountSwapped, feeDeducted, amountBridged, durationMs) and `OutboundPipelineOptions` interface (fundId, sdk, wallet, connection, db, platformTreasuryWallet).

2. Create `src/pipeline/outbound.ts` with `runOutboundPipeline(opts: OutboundPipelineOptions): Promise<OutboundPipelineResult>`. Implementation:
   - Validate fund: `getFundById(db, fundId)` → assert status === 'active', throw if not
   - Get fund wallets: `getFundWallets(db, fundId)` → find base wallet for bridge recipient
   - Create pipeline run: `createPipelineRun(db, { fundId, direction: 'outbound', phase: 'claiming', status: 'running', startedAt: new Date() })`
   - Wrap entire pipeline in try/catch — on error, `updatePipelineRun(db, runId, { status: 'failed', error: err.message })`

3. Implement claim phase:
   - Get SOL balance before claim via `connection.getBalance(wallet.publicKey)`
   - Call `getClaimTransactions(sdk, wallet.publicKey.toBase58(), fund.tokenMint)`
   - If transactions returned, call `signAndSendClaimTransactions(connection, wallet, transactions)`
   - Get SOL balance after claim, compute claimedAmount = afterBalance - beforeBalance
   - Record transaction: `recordTransaction(db, { fundId, pipelineRunId, chain: 'solana', txHash: signatures[0], operation: 'fee_claim', amount: String(claimedAmount), token: 'SOL' })`
   - Update pipeline run: `updatePipelineRun(db, runId, { phase: 'swapping' })`

4. Implement swap phase:
   - Compute swapAmount = claimedAmount minus a buffer for tx fees (e.g. 10_000 lamports)
   - Call `swapSolToUsdc(swapAmount, wallet, connection)`
   - Record transaction: `recordTransaction(db, { ..., operation: 'swap', amount: result.outAmount, token: SOLANA_KNOWN_ADDRESSES.USDC })`
   - Update pipeline run: `updatePipelineRun(db, runId, { phase: 'bridging' })`

5. Implement protocol fee deduction (R016):
   - Compute `feeAmount = BigInt(swapResult.outAmount) * BigInt(fund.protocolFeeBps) / 10000n`
   - Build a raw SPL Token transfer instruction using `TransactionInstruction` with Token Program ID (`SOLANA_KNOWN_ADDRESSES.SPL_TOKEN_PROGRAM_ID`), the USDC mint, wallet ATA as source, platform treasury ATA as destination, amount = feeAmount
   - Use `getAssociatedTokenAddressSync` equivalent: derive ATAs from the Token Program ID + mint + owner using `PublicKey.findProgramAddressSync` with the standard ATA seed layout
   - Build, sign, and send the fee transfer transaction
   - Record transaction with operation 'fee_claim' (protocol fee)
   - Compute bridgeAmount = BigInt(swapResult.outAmount) - feeAmount

6. Implement bridge phase:
   - Get fund's base wallet address from wallets array
   - Call `createBridgeOrder({ srcChainId: DeBridgeChainId.SOLANA, srcChainTokenIn: SOLANA_KNOWN_ADDRESSES.USDC, srcChainTokenInAmount: String(bridgeAmount), dstChainId: DeBridgeChainId.BASE, dstChainTokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dstChainTokenOutRecipient: baseWalletAddress, prependOperatingExpenses: true })`
   - Call `prepareSolanaTransaction(connection, order.tx.data, wallet.publicKey)`
   - Call `sendAndConfirmBridgeTransaction(connection, signedTx)`
   - Record bridge_send transaction on solana chain
   - Call `waitForFulfillment(order.orderId)` with reasonable timeout
   - Record bridge_receive transaction on base chain
   - Update pipeline run: `updatePipelineRun(db, runId, { status: 'completed', completedAt: new Date() })`

7. Return `OutboundPipelineResult` with all collected data.

8. Add structured logging at each phase using the project's `log(phase, action, data)` pattern.

## Important constraints
- Do NOT add `@solana/spl-token` as a dependency. Build the SPL transfer instruction from raw primitives using `@solana/web3.js` TransactionInstruction + PublicKey. The Associated Token Account address can be derived using `PublicKey.findProgramAddressSync` with seeds `[ownerPubkey, TOKEN_PROGRAM_ID, mintPubkey]` and the ATA program ID `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
- Use `BigInt` for all USDC amount arithmetic (atomic units can exceed Number.MAX_SAFE_INTEGER for large amounts).
- Follow the existing dependency injection pattern — all external deps (db, sdk, connection, wallet) passed as params.
- Follow the existing structured logging pattern: `function log(phase, action, data)` with JSON to stdout.
  - Estimate: 1h30m
  - Files: src/pipeline/types.ts, src/pipeline/outbound.ts, src/config/solana.ts
  - Verify: npx tsc --noEmit 2>&1 | grep -v "discover-factory\|jupiter-swap.ts\|bags-fee-share.test" | grep -c "error TS" || echo 0 — must be 0 new errors from src/pipeline/ files
- [x] **T02: Added 20 unit tests for outbound pipeline with fully mocked subsystems — all passing** — Create comprehensive unit tests for the outbound pipeline orchestrator, mocking all subsystem functions to verify orchestration logic, phase transitions, fee calculation, error handling, and fund validation.

## Steps

1. Create `tests/outbound-pipeline.test.ts`. Import the pipeline function and types.

2. Set up vi.mock for all subsystem modules:
   - `vi.mock('../src/bags/fee-claim.js')` — mock getClaimTransactions (returns base64 tx array) and signAndSendClaimTransactions (returns signature strings)
   - `vi.mock('../src/jupiter/swap.js')` — mock swapSolToUsdc (returns { signature, inAmount, outAmount })
   - `vi.mock('../src/debridge/api.js')` — mock createBridgeOrder (returns order with tx.data and orderId) and waitForFulfillment (returns fulfilled status)
   - `vi.mock('../src/debridge/solana-tx.js')` — mock prepareSolanaTransaction and sendAndConfirmBridgeTransaction
   - Mock `@solana/web3.js` Connection.getBalance (returns SOL balances for before/after claim), Connection.getLatestBlockhash, Connection.sendTransaction, Connection.confirmTransaction
   - Suppress console.log via `vi.spyOn(console, 'log').mockImplementation()`

3. Create a mock db object that stubs the fund-repository functions:
   - `getFundById` returns a fund with status 'active', tokenMint, protocolFeeBps: 500 (5%)
   - `getFundWallets` returns solana + base wallets
   - `createPipelineRun` returns a pipeline run object with generated id
   - `updatePipelineRun` returns the updated run
   - `recordTransaction` returns a transaction object with generated id
   Build this as a factory function for reuse.

4. Write test cases:
   a. **Happy path**: full pipeline completes, returns result with all tx hashes, correct amounts, feeDeducted matches protocolFeeBps
   b. **Protocol fee calculation**: verify feeDeducted = outAmount * protocolFeeBps / 10000 (use multiple bps values: 0, 500, 1000)
   c. **Fund validation**: non-active fund throws, missing fund throws
   d. **Claim phase error**: getClaimTransactions throws → pipeline run updated with failure
   e. **Swap phase error**: swapSolToUsdc throws → pipeline run updated with failure, phase = 'swapping'
   f. **Bridge phase error**: sendAndConfirmBridgeTransaction throws → pipeline run updated with failure, phase = 'bridging'
   g. **Transaction recording**: verify recordTransaction called correct number of times with correct operations
   h. **Pipeline run phases**: verify updatePipelineRun called with correct phase progression (claiming→swapping→bridging→completed)
   i. **Zero fee**: protocolFeeBps = 0 → no fee transfer, full amount bridged

5. Suppress console.log in beforeEach, restore in afterEach.

## Important constraints
- The db mock must NOT require PostgreSQL — pure in-memory stubs returning typed objects.
- Use `vi.mock` with factory functions, not manual module replacement.
- All mocked return values must match the actual TypeScript types from the subsystem modules.
- Follow the existing test pattern: see `tests/debridge-api.test.ts` or `tests/jupiter-swap.test.ts` for vi.mock + globalThis.fetch patterns.
  - Estimate: 1h
  - Files: tests/outbound-pipeline.test.ts
  - Verify: npx vitest run tests/outbound-pipeline.test.ts — all tests pass
- [x] **T03: Created CLI script with --dry-run and --fund-id args for manual outbound pipeline execution and validation** — Create a CLI entry point for manual end-to-end testing of the outbound pipeline, following the pattern established by existing scripts.

## Steps

1. Create `scripts/outbound-pipeline.ts` following the pattern in `scripts/jupiter-swap.ts`:
   - `#!/usr/bin/env tsx` shebang
   - `import 'dotenv/config'`
   - Structured `log(phase, action, data)` helper
   - Parse args: `--fund-id <uuid>` (required), `--dry-run` (optional flag)
   - Validate required env vars: `DATABASE_URL`, `SOL_PRIVATE_KEY`, `PLATFORM_TREASURY_WALLET`

2. In dry-run mode:
   - Connect to DB, load fund by ID, print fund details and wallets
   - Validate fund is active
   - Print what would happen: "Would claim reflections for mint X, swap to USDC, deduct Y% fee, bridge to Base wallet Z"
   - Exit without executing

3. In live mode:
   - Create Solana connection via `createSolanaConnection()`
   - Load keypair via `loadSolanaKeypair(process.env.SOL_PRIVATE_KEY)`
   - Create BagsSDK instance
   - Create DB connection
   - Call `runOutboundPipeline({ fundId, sdk, wallet, connection, db, platformTreasuryWallet })`
   - Print result: pipeline run ID, all tx hashes, amounts, fee deducted, duration

4. Add error handling with human-readable output and exit code 1 on failure.

5. Add npm script to package.json: `"outbound-pipeline": "tsx scripts/outbound-pipeline.ts"`

## Important constraints
- Follow the exact CLI pattern from `scripts/jupiter-swap.ts` (dotenv, arg parsing, structured logging, phase/action pattern)
- The BagsSDK constructor signature: `new BagsSDK()` (check `src/bags/client.ts` for actual init)
- DB connection: use `createDb()` from `src/db/connection.ts`
  - Estimate: 30m
  - Files: scripts/outbound-pipeline.ts, package.json
  - Verify: npx tsx scripts/outbound-pipeline.ts --help 2>&1 || npx tsx scripts/outbound-pipeline.ts --dry-run --fund-id test 2>&1 — script loads without import errors

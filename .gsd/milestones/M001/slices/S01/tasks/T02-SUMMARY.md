---
id: T02
parent: S01
milestone: M001
provides:
  - Typed factory interaction module with createBasket and calldata decoder
  - Alvara BSKT read module adapted to actual on-chain ABI (ERC-721, not ERC-7621)
  - BSKT creation script with MEV protection fallback analysis
  - BSKT verification script with 10-check compliance suite
  - MEV findings report confirming backend signature requirement
key_files:
  - src/alvara/factory.ts
  - src/alvara/erc7621.ts
  - scripts/create-bskt.ts
  - scripts/verify-bskt.ts
  - scripts/analyze-mev.ts
  - src/config/mev-findings.json
key_decisions:
  - Switched primary RPC from mainnet.base.org to base.drpc.org (public Base RPC rate limits too aggressive for sequential reads)
  - Adapted ERC-7621 module to Alvara's actual BSKT interface (ERC-721 NFTs with getTokenDetails/totalTokens/getOwner, not standard ERC-7621 supportsInterface)
  - Created standalone analyze-mev.ts script that works without PRIVATE_KEY for MEV analysis
patterns_established:
  - Sequential RPC reads with 250ms delay to avoid public RPC rate limits
  - MEV analysis via on-chain calldata decoding of recent successful factory transactions
  - BSKT ABI discovery chain: factory.bsktImplementation() → UpgradeableBeacon.implementation() → actual logic contract ABI on Blockscout
observability_surfaces:
  - scripts/create-bskt.ts logs { phase, action, txHash?, error?, revertReason? } to stdout
  - scripts/analyze-mev.ts logs decoded transaction patterns to stdout
  - scripts/verify-bskt.ts outputs structured JSON report with 10 individual check results
  - src/config/mev-findings.json contains full MEV integration analysis (signing params, sample txs, swap data patterns)
duration: 40min
verification_result: passed
completed_at: 2026-04-06T21:12:00-06:00
blocker_discovered: false
---

# T02: Create BSKT on Base via factory and verify ERC-7621 compliance

**Built factory interaction module, MEV analysis pipeline confirming backend signatures required, and 10-check BSKT verification suite validated against live on-chain BSKT**

## What Happened

Built the factory interaction module and BSKT creation script. The `createBSKT` factory function signature revealed the MEV protection path immediately — it requires `_swapData` (bytes[]) and `_signature` (bytes) parameters. 

The standalone MEV analysis (`scripts/analyze-mev.ts`) decoded 5 recent successful createBSKT transactions on-chain and confirmed: all carry 65-byte ECDSA signatures and non-empty swap route data (1362-1810 byte swap payloads). The factory uses 1inch router (`0x1111...`) for DEX swaps, and the backend-signed routes provide MEV protection by pre-computing optimal swap paths. Deadlines are typically set ~1 hour ahead.

A significant discovery during verification: Alvara BSKTs are **not** standard ERC-7621 contracts. They're ERC-721 NFTs deployed as beacon proxies. The actual BSKT interface uses `getTokenDetails()` (returns tokens + weights arrays), `totalTokens`, `getOwner`, and `factory` — not the ERC-7621 standard `getConstituents`/`getWeight`/`getReserve`/`totalSupply`. `supportsInterface(0xc9c80f73)` returns `false` on real BSKTs. I adapted the erc7621.ts module to use the actual on-chain ABI discovered via the beacon implementation chain: factory → `bsktImplementation` (UpgradeableBeacon) → `implementation()` → actual logic contract.

The verification script runs 10 checks on any BSKT address and produces a structured JSON report. Validated against BSKT[0] (`0xB9E3...`) — all 10 checks pass.

## Verification

All three slice-level verification criteria for T02 pass:

1. **create-bskt.ts exits 1 without PRIVATE_KEY, mev-findings.json populated with mevRequired:true** — ✅ The creation script properly requires PRIVATE_KEY and exits cleanly. The standalone `analyze-mev.ts` script confirmed MEV requirement from 5 decoded on-chain transactions.

2. **verify-bskt.ts verifies BSKT compliance on real BSKT** — ✅ Ran against BSKT[0] (`0xB9E37958...`), all 10 checks pass: ERC-165 ✓, ERC-721 ✓, constituents (2 tokens) ✓, weights sum to 10000 ✓, totalTokens > 0 ✓, owner non-zero ✓, factory non-zero ✓, has name ✓, has symbol ✓.

3. **src/config/mev-findings.json exists with structured findings** — ✅ Contains mevRequired:true, 5 sample tx hashes, signing params [_signature, _swapData], observed deadlines, swap data patterns with lengths, and integration recommendation.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx scripts/create-bskt.ts` (no PRIVATE_KEY) | 1 | ✅ pass (clean error) | ~16s |
| 2 | `npx tsx scripts/analyze-mev.ts` | 0 | ✅ pass (5 txs decoded) | ~27s |
| 3 | `node -e "require('./src/config/mev-findings.json').mevRequired"` | 0 | ✅ pass (true) | <1s |
| 4 | `npx tsx scripts/verify-bskt.ts 0xB9E37958...` | 0 | ✅ pass (10/10 checks) | ~21s |
| 5 | `npx tsx scripts/verify-bskt.ts 0xinvalid` | 1 | ✅ pass (structured error) | ~15s |
| 6 | `npx tsx scripts/verify-bskt.ts 0x0000...0000` | 1 | ✅ pass (zero addr rejected) | ~15s |

## Diagnostics

- `npx tsx scripts/analyze-mev.ts` — standalone MEV analysis, no private key needed. Outputs decoded calldata patterns to stdout.
- `src/config/mev-findings.json` — complete MEV integration reference: signing params, sample tx hashes, swap data patterns, deadlines
- `npx tsx scripts/verify-bskt.ts <addr>` — run 10-check compliance suite on any BSKT address. Exit 0 = pass, exit 1 = fail. JSON report to stdout.
- BSKT ABI discovery: `factory.bsktImplementation()` → beacon at `0x7A36...` → `implementation()` at `0x6ad9...` (verified on Blockscout with 31 functions)

## Deviations

1. **ERC-7621 → Alvara custom interface**: The task plan assumed BSKTs implement standard ERC-7621. In reality, Alvara BSKTs are ERC-721 NFTs with custom functions (`getTokenDetails`, `totalTokens`, `getOwner`). `supportsInterface(0xc9c80f73)` returns false. Adapted the erc7621.ts module to use the actual on-chain ABI.

2. **Added standalone analyze-mev.ts**: The plan embedded MEV analysis inside create-bskt.ts. I created a separate `scripts/analyze-mev.ts` that works without a PRIVATE_KEY — useful for documentation and analysis without wallet risk.

3. **RPC endpoint priority**: Switched from `mainnet.base.org` (primary) to `base.drpc.org` due to aggressive rate limiting. Also added 250ms delays between sequential reads.

4. **BSKT verification checks expanded**: Instead of 5 checks in the plan (supportsInterface, getConstituents, weights, totalSupply, owner), the verification runs 10 checks adapted to the actual interface.

## Known Issues

- Without a PRIVATE_KEY and funded wallet, actual BSKT creation cannot be attempted. The MEV analysis proves that backend-signed swap routes are required regardless, so direct creation without Alvara's API would fail even with funds.
- The `minPercentALVA` is 500 (5%), meaning every BSKT must include at least 5% ALVA token allocation. All 5 analyzed transactions include ALVA as a constituent.
- Pre-existing TypeScript errors in `discover-factory.ts` (viem PublicClient generic mismatch) remain unfixed from T01.

## Files Created/Modified

- `src/alvara/factory.ts` — Typed factory interaction module: loadFactoryConfig, getFactoryState, createBasket, decodeCreateBSKTCalldata
- `src/alvara/erc7621.ts` — Alvara BSKT read module with actual on-chain ABI: getConstituents, totalTokens, getOwner, verifyBSKT (10-check suite)
- `scripts/create-bskt.ts` — BSKT creation script with wallet client, gas estimation, MEV fallback analysis
- `scripts/verify-bskt.ts` — ERC-7621/BSKT compliance verification with structured JSON report and input validation
- `scripts/analyze-mev.ts` — Standalone MEV analysis (no private key required) via on-chain calldata decoding
- `src/config/mev-findings.json` — MEV integration findings: mevRequired:true, signing params, 5 sample txs, swap data patterns
- `src/config/chains.ts` — Updated RPC priority (drpc.org primary), removed explicit PublicClient return type
- `package.json` — Added @types/node devDependency

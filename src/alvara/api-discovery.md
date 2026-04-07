# Alvara Backend API Discovery

## Summary

Alvara uses a **backend signing service** that computes optimal swap routes via 1inch Swap API and signs them for MEV protection. All token swap operations (create, contribute, redeem-ETH, rebalance, claim-fee) require backend-signed `_swapData` and `_signature` parameters.

## Architecture

```
User (frontend)                 Alvara Backend              On-chain
     │                               │                        │
     │─── Request swap routes ──────>│                        │
     │    (tokens, weights, amount)  │                        │
     │                               │── Query 1inch API ────>│
     │                               │<── Swap routes ────────│
     │                               │                        │
     │<── Signed swap data ──────────│                        │
     │    (_swapData[], _signature,  │                        │
     │     _deadline)                │                        │
     │                               │                        │
     │────── Submit tx ─────────────────────────────────────> │
     │       (BSKT.contribute{value}│                        │
     │        or factory.createBSKT) │                        │
```

## Frontend Access

The Alvara frontend at `bskt.alvara.xyz` is protected by Cloudflare WAF, preventing direct HTTP scraping. The frontend is a React/Next.js SPA that communicates with the Alvara backend API.

**Cloudflare protection:** Direct `curl` or `fetch` requests return a Cloudflare challenge page. Browser-based access with JavaScript execution is required to interact with the frontend.

## Contract Interfaces Discovered

### BSKT Contract (`BasketTokenStandard`)

The BSKT NFT contract (beacon proxy → `0x6ad920eBd298c8dE0888B796B59c5CcE4911655C`) contains all investment operations:

| Function | Signature | Description |
|----------|-----------|-------------|
| `contribute` | `contribute(bytes[] _swapData, bytes _signature, uint256 _deadline) payable` | Invest ETH into existing BSKT, receive LP tokens |
| `withdraw` | `withdraw(uint256 _liquidity)` | Redeem LP for underlying tokens (no swap, no signature needed) |
| `withdrawETH` | `withdrawETH(uint256 _liquidity, bytes[] _swapData, bytes _signature, uint256 _deadline)` | Redeem LP for ETH (needs backend swap routes) |
| `rebalance` | `rebalance(address[] _newTokens, uint256[] _newWeights, uint256[] _amountIn, bytes[] _swapData, bytes _signature, uint256 _deadline, uint8 _mode)` | Rebalance basket (manager only) |
| `claimFee` | `claimFee(uint256 amount, bytes[] _swapData, bytes _signature, uint256 _deadline, bool withdrawIndividualTokens, bool withdrawFullAmount)` | Claim management fees |

### BSKTPair Contract (`BasketTokenStandardPair`)

ERC-20 LP token contract. Key functions:

| Function | Signature | Description |
|----------|-----------|-------------|
| `mint` | `mint(address to, uint256 totalETH, uint256[] amounts, uint256[] allocatedAmounts) → uint256 liquidity` | Mint LP tokens (called internally by BSKT.contribute) |
| `burn` | `burn(address to) → uint256[] actualAmounts` | Burn LP tokens (called internally by BSKT.withdraw) |
| `balanceOf` | `balanceOf(address account) → uint256` | LP token balance |
| `totalSupply` | `totalSupply() → uint256` | Total LP supply |
| `calculateShareLP` | `calculateShareLP(uint256 _amountETH, uint256[] _amounts, uint256[] _allocatedAmounts) → uint256 amountLP` | Preview LP tokens for a given ETH amount |
| `calculateShareTokens` | `calculateShareTokens(uint256 _amountLP) → uint256[] amountTokens` | Preview tokens for a given LP amount |
| `getTokensReserve` | `getTokensReserve() → uint256[]` | Current token reserves |
| `getTokenList` | `getTokenList() → address[]` | List of constituent token addresses |
| `getTokenAndUserBal` | `getTokenAndUserBal(address _user) → (uint256[], uint256, uint256)` | User's balances and total supply |

### BSKTUtils Contract (`0x65b403e2323A...`)

Signature verification contract (TransparentUpgradeableProxy → `0x3d4D13748034...`):

| Function | Description |
|----------|-------------|
| `verifySignature` | Verifies backend signatures on-chain |
| `signer` | Returns the current signer address |

### Factory Contract

Only handles BSKT creation (not contributions):

| Function | Description |
|----------|-------------|
| `createBSKT(...)` | Create new BSKT with initial investment |
| `bsktPairImplementation()` | BSKTPair beacon address |
| `bsktImplementation()` | BSKT beacon address |
| `bsktUtils()` | BSKTUtils address for signature verification |

## Contribution Flow (Investing in Existing BSKT)

1. **User specifies ETH amount** to invest
2. **Backend receives request:** BSKT address + ETH amount + user address
3. **Backend queries 1inch Swap API** for optimal routes from ETH → each constituent token (weighted by basket allocation)
4. **Backend signs the swap data** with a private key (verified on-chain by BSKTUtils.verifySignature)
5. **Backend returns:** `_swapData[]` (1inch router calldata per token), `_signature` (ECDSA signature), `_deadline` (Unix timestamp, typically ~1 hour ahead)
6. **User sends transaction:** `BSKT.contribute{value: ethAmount}(_swapData, _signature, _deadline)`
7. **On-chain execution:** BSKT verifies signature → wraps ETH to WETH → deducts platform fee → executes 1inch swaps → transfers tokens to BSKTPair → calls BSKTPair.mint() → LP tokens minted to user

## Observed Transaction Patterns

### contribute() transactions
- **ETH value:** 0.001 ETH (1000000000000000 wei) in observed samples
- **_swapData:** Array of 1inch router v6 calldata (function selector `0x07ed2379` = 1inch swap)
- **_signature:** 65 bytes ECDSA signature (130 hex chars + 0x prefix = 132 chars)
- **_deadline:** Unix timestamp, typically 1 hour in the future
- **Platform fee:** Deducted from ETH before swaps (PlatformFeeDeducted event)
- **1inch router:** `0x111111125421cA6dc452d289314280a0f8842A65` (on Base)

### createBSKT() transactions
- Same `_swapData` and `_signature` pattern
- Additional parameters: name, symbol, tokens, weights, tokenURI, basketId, description
- Minimum 0.00001 ETH (minBSKTCreationAmount)

## Backend API Endpoints (Inferred)

The exact API URL is embedded in the Cloudflare-protected frontend JavaScript bundle. Based on the contract interface and common patterns:

**Likely base URL:** `https://api.alvara.xyz` or `https://bskt-api.alvara.xyz`

**Likely endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/swap-routes` or `/contribute` | POST | Get signed swap data for contributing to a BSKT |
| `/create-bskt` | POST | Get signed swap data for creating a new BSKT |
| `/rebalance` | POST | Get signed swap data for rebalancing |
| `/withdraw-eth` | POST | Get signed swap data for ETH withdrawal |

**Likely request shape (contribute):**
```json
{
  "bsktAddress": "0x...",
  "amount": "1000000000000000",
  "chainId": 8453,
  "userAddress": "0x..."
}
```

**Likely response shape:**
```json
{
  "swapData": ["0x07ed2379...", "0x07ed2379..."],
  "signature": "0x5563db78...",
  "deadline": 1770896974
}
```

## Key Discovery: No Public API Documentation

Alvara does not publish public API documentation for their backend signing service. The API is designed to be consumed exclusively by their frontend. For programmatic BSKT investment:

1. **Browser automation approach:** Use the bskt.alvara.xyz frontend via Playwright/Puppeteer to trigger the backend API calls naturally
2. **Direct API probing:** Once the API base URL is discovered (from frontend JS bundle), endpoints can be called directly with proper headers
3. **1inch direct integration:** For complete independence, compute swap routes directly via 1inch Swap API and self-sign — but this requires understanding Alvara's signature scheme (the signer address from BSKTUtils)

## Contract Addresses

| Contract | Address | Type |
|----------|---------|------|
| Factory | `0x9ee08080161D443112ab5d9a3Ca96010E569E229` | Upgradeable Proxy |
| Factory Impl | `0x296baaa6420f178b743338d183ffbb52fba8bdbe` | Logic |
| BSKT Beacon | `0x7a36e79b087bfaeb5c18ee42e252f8c60fcd4713` | UpgradeableBeacon |
| BSKT Impl | `0x6ad920eBd298c8dE0888B796B59c5CcE4911655C` | BasketTokenStandard |
| BSKTPair Beacon | `0x06136C31dB2FbED3Fed758A0F5B0Ce30DAeACc43` | UpgradeableBeacon |
| BSKTPair Impl | `0x6aB0dD3527697Ffa286c9701b5EC92C53D388EE4` | BasketTokenStandardPair |
| BSKTUtils | `0x65b403e2323A321b7347b383FC80B8f0EeE57387` | TransparentUpgradeableProxy |
| BSKTUtils Impl | `0x3d4D137480343035778d3b5b72e4f99c0f12d041` | BSKTUtils |
| 1inch Router | `0x111111125421cA6dc452d289314280a0f8842A65` | 1inch Aggregation Router V6 |
| ALVA Token | `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb` | TransparentUpgradeableProxy |
| WETH | `0x4200000000000000000000000000000000000006` | Wrapped ETH on Base |

## Discovery Date

2026-04-07

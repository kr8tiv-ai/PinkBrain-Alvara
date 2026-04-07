# S01 Research: Alvara Factory Discovery & BSKT Proof

## Summary

This slice must reverse-engineer Alvara's BSKT factory contract addresses from on-chain data (no SDK, no published ABI), then prove programmatic BSKT creation by deploying a real basket on Base. This is the highest-risk item in M001 because Alvara has no public factory source code, and their MEV protection system introduces a backend signing layer between the user and the chain.

**Requirements owned:** R006 (factory discovery — primary), R007 (BSKT creation — primary), R021 (dual-chain support — supporting)

## Recommendation

**Approach:** Two-phase: (1) on-chain forensics to discover factory + router contracts via Basescan/Etherscan transaction analysis, then (2) ABI reconstruction and direct contract call to create a BSKT, bypassing the frontend but potentially needing to replicate the MEV protection signing flow.

**Sequencing:** Discovery first (pure reads, zero cost), then creation proof (requires ~0.1 ETH on Base). If MEV backend signing blocks direct factory calls, escalate to the user with a decision: intercept the frontend's API calls to understand the signing protocol, or contact Alvara team.

**Tech stack:** TypeScript, viem (EVM client), Basescan/Etherscan APIs for transaction trace analysis.

## Implementation Landscape

### What Exists

- **Empty repository** — no code whatsoever.
- **Alvara GitHub** — 6 repos, all public. Only ALVA token contract (`AlvaraToken.sol`) and docs. No factory, no router, no BSKT implementation source.
- **Alvara docs** at `docs.alvara.xyz` — GitBook docs covering BSKT Lab creation flow, rebalancing, MEV protection, supported networks. No contract addresses published. No developer API docs.
- **ERC-7621 EIP** — full interface spec published at `eips.ethereum.org/EIPS/eip-7621`. Interface ID `0xc9c80f73`. Defines `contribute()`, `withdraw()`, `rebalance()`, `getConstituents()`, `getWeight()`, `getReserve()`, `totalBasketValue()`, preview functions. Ownership via ERC-173.
- **Known addresses:**
  - ALVA on Base: `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`
  - ALVA on Ethereum: `0x8e729198d1C59B82bd6bBa579310C40d740A11C2`
  - ALVA on Avalanche: `0xd18555a6c2fda350069735419900478eec4abd96`

### What Must Be Built

1. **Factory discovery script** — trace BSKT creation transactions on Basescan to find the factory contract address
2. **ABI reconstruction module** — extract function signatures from transaction input data, cross-reference with ERC-7621 interface
3. **BSKT creation proof script** — call the factory to deploy a real BSKT with constituent tokens on Base
4. **Verification script** — confirm the BSKT exists, has correct constituents, and is queryable via ERC-7621 interface

### Where the Seams Are

- **Discovery vs. creation** — completely independent until the factory address is known. Discovery is pure on-chain reads; creation requires a wallet with ETH.
- **Base vs. Ethereum** — can be researched in parallel. Base deployment is 4 days old (April 2, 2026) so fewer transactions to analyze. Ethereum has been live since October 2025 with more data.
- **Factory contract vs. MEV router** — the factory deploys BSKTs, but the MEV protection layer routes swaps through a separate signing service. These are likely separate contracts.

## Key Findings

### 1. The BSKT Creation Architecture (from docs)

The creation flow works like this:
1. User sends ETH to the factory
2. ETH is split by allocation weights
3. Each portion is swapped to constituent tokens via DEX (1inch aggregator)
4. Tokens are deposited into a new BSKT smart contract
5. LP tokens are minted to the creator
6. A management NFT (ERC-721) is minted to the creator

This all happens in a **single transaction**. The factory contract orchestrates the entire flow.

### 2. MEV Protection — The Critical Risk

Alvara's MEV protection works by:
1. Frontend sends transaction details to Alvara's backend
2. Backend computes optimal swap routes (via 1inch)
3. Backend signs the transaction data with a deadline
4. Signed data is included in the on-chain transaction
5. Contract verifies the backend signature before executing swaps

**Protected operations:** BSKT creation, deposits, ETH redemptions, rebalancing, fee claiming, emergency stables.

**Key question:** Does the factory contract REQUIRE the backend signature for creation, or is it optional MEV protection that can be bypassed? The answer determines whether we can call the factory directly.

**Likely answer based on analysis:** The factory probably accepts signed swap route data as a parameter. Without the signature, the contract either reverts OR falls back to on-chain routing (less optimal but functional). We won't know until we inspect the factory bytecode.

**Mitigation paths if backend signature is required:**
- **Path A:** Intercept the frontend's API calls to Alvara's backend to understand the signing protocol, then replicate it programmatically
- **Path B:** Use Alvara's frontend to create one BSKT manually, capture the full transaction calldata, and decode the factory function signature and parameter structure from that
- **Path C:** Contact Alvara team (user has explicitly declined this — D002)

### 3. Contract Discovery Strategy

**Primary approach — transaction trace analysis:**
1. Go to `bskt.alvara.xyz`, find any existing BSKT on Base
2. Find the BSKT's contract address via the Alvara explorer/leaderboard
3. Trace back the BSKT's creation transaction on Basescan
4. The `to` address of that transaction (or the internal transaction deployer) is the factory
5. Decode the transaction input data to reconstruct the factory's `createBasket()` ABI

**Fallback approach — ALVA token analysis:**
1. The ALVA token on Base (`0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`) must have been deployed by the Alvara team
2. Check the deployer address's other contract deployments on Basescan
3. The factory and router contracts were likely deployed from the same deployer

**Additional signals:**
- BSKTs include a mandatory minimum ALVA allocation on Ethereum (5%), but this requirement is "changing with the Base deployment" per docs — Base BSKTs may not require ALVA
- The factory charges a creation fee (% of initial deposit)
- Management NFT is ERC-721 — there's likely a separate NFT contract or the factory mints from an integrated NFT collection

### 4. ERC-7621 Interface (key functions for verification)

```solidity
interface IERC7621 {
    function getConstituents() external view returns (address[] memory tokens, uint256[] memory weights);
    function totalConstituents() external view returns (uint256 count);
    function getReserve(address token) external view returns (uint256 balance);
    function getWeight(address token) external view returns (uint256 weight);
    function isConstituent(address token) external view returns (bool);
    function totalBasketValue() external view returns (uint256 value);
    function contribute(uint256[] calldata amounts, address receiver, uint256 minShares) external returns (uint256 lpAmount);
    function withdraw(uint256 lpAmount, address receiver, uint256[] calldata minAmounts) external returns (uint256[] memory amounts);
    function rebalance(address[] calldata newTokens, uint256[] calldata newWeights) external;
    function previewContribute(uint256[] calldata amounts) external view returns (uint256 lpAmount);
    function previewWithdraw(uint256 lpAmount) external view returns (uint256[] memory amounts);
}
// ERC-165 interface ID: 0xc9c80f73
// Ownership: ERC-173 (owner() controls rebalance)
// Weights: basis points (10000 = 100%), must sum to 10000
```

### 5. Proxy Pattern Likelihood

Alvara's contracts are almost certainly upgradeable proxies:
- They launched on Ethereum first, then "forked" to Base — proxy pattern makes multi-chain deployment efficient
- V2 upgrade was announced alongside Base launch — suggests proxy upgrade capability
- Factory contracts in production DeFi almost always use proxies for upgradeability

**Discovery implication:** Need to check EIP-1967 storage slots on discovered contracts:
- Implementation slot: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
- Admin slot: `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`

### 6. Rebalancing Architecture (two-phase, relevant to later milestones)

Rebalancing is NOT a single `rebalance()` call as ERC-7621 spec suggests. Alvara's implementation uses two separate transactions:
1. **Phase 1 (Initialize):** Sell all current tokens to WETH
2. **Phase 2 (Rebalance):** Buy new tokens from WETH according to new weights

Both phases require MEV protection backend signing. This is important context for M002/M003 but out of scope for S01.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| MEV backend signature required for creation | HIGH | Path A: intercept frontend API. Path B: manually create one BSKT and decode calldata. Both provide the function signature without needing Alvara team cooperation. |
| Factory is upgradeable proxy — address changes | MEDIUM | Read EIP-1967 implementation slot. Store both proxy and implementation addresses. Monitor for upgrades. |
| Base deployment is only 4 days old — few creation txs to analyze | LOW | Can cross-reference with Ethereum mainnet deployment (live since Oct 2025) which has many more transactions. Factory architecture is likely identical. |
| Basescan API rate limits during discovery | LOW | Use free tier (5 calls/sec). Cache aggressively. Discovery is a one-time operation. |
| Minimum 0.1 ETH seed requirement | LOW | Budget ~$200 for test creation. Use cheap constituent tokens with good Base liquidity (WETH, USDC, ALVA). |

## Don't Hand-Roll

- **EVM interaction:** Use `viem` — type-safe, excellent ABI encoding/decoding, storage slot reads, transaction tracing support
- **Block explorer APIs:** Use Basescan/Etherscan free API for transaction lookups. Don't scrape HTML.
- **ABI decoding:** Use viem's `decodeFunctionData` / `decodeEventLog` — don't manually parse calldata hex
- **Proxy detection:** Use viem's `getStorageAt` for EIP-1967 slots — don't guess at proxy patterns

## Suggested Skills

The following external skills may be useful for this slice:
- `austintgriffith/ethereum-wingman@ethereum-wingman` (277 installs) — Ethereum development guidance
- `docs.etherscan.io@etherscan` (40 installs) — Etherscan/Basescan API usage

## Verification Strategy

### Discovery Verification
- Factory contract address is valid (has code deployed)
- Factory has been called to create at least one BSKT (Basescan tx history)
- Decoded ABI matches expected ERC-7621 factory pattern (createBasket or similar function)
- If proxy: implementation contract address retrieved from EIP-1967 slot

### Creation Verification
- A new BSKT contract address is returned from the factory call
- The BSKT implements ERC-165 and returns true for `0xc9c80f73` (IERC7621 interface ID)
- `getConstituents()` returns the tokens and weights we specified
- `totalSupply()` > 0 (LP tokens were minted)
- Creator wallet holds LP tokens and management NFT
- BSKT is visible on Basescan as a verified/unverified contract
- `owner()` returns the creator wallet address (ERC-173)

### End-to-End Proof
- Run: `npx tsx scripts/discover-factory.ts` → outputs factory address, decoded ABI
- Run: `npx tsx scripts/create-bskt.ts` → outputs BSKT address, tx hash
- Run: `npx tsx scripts/verify-bskt.ts <bskt-address>` → confirms ERC-7621 compliance
- All tx hashes verifiable on Basescan

## Sources

- ERC-7621 spec: https://eips.ethereum.org/EIPS/eip-7621
- Alvara docs (BSKT Lab): https://docs.alvara.xyz/bskt-lab/creating-a-bskt
- Alvara docs (Funding & Deployment): https://docs.alvara.xyz/bskt-lab/funding-and-deployment
- Alvara docs (MEV Protection): https://docs.alvara.xyz/security/mev-protection
- Alvara docs (Rebalancing): https://docs.alvara.xyz/fund-managers/rebalancing
- Alvara docs (Supported Networks): https://docs.alvara.xyz/getting-started/supported-networks
- Alvara GitHub: https://github.com/Alvara-Protocol (6 repos, no factory source)
- Alvara V2 + Base launch announcement (April 2, 2026): https://visionary-finance.com article
- viem docs: https://viem.sh

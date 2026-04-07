# M001: Risk Retirement & Subsystem Proof

**Gathered:** 2026-04-06
**Status:** Ready for planning

## Project Description

PinkBrain Alvara Fund is a multi-tenant Bags.fm app store application that automates a cross-chain financial pipeline: Solana token reflections → bridge → Alvara ERC-7621 basket on EVM → auto-divest → distribute to holders. Created by $BRAIN but generic for any Bags.fm token. The app takes a protocol fee on reflections.

## Why This Milestone

Every critical subsystem in this project is unproven. Alvara has no public SDK or published factory contracts. deBridge cross-chain bridging is the highest-risk component. Bags SDK fee share redirection hasn't been tested programmatically for this use case. Before building any pipeline automation, each subsystem must be proven independently to avoid building on top of assumptions that collapse.

## User-Visible Outcome

### When this milestone is complete, the user can:

- See a BSKT created programmatically on Alvara (Base) via discovered factory contracts
- See USDC bridged from Solana to Base via deBridge DLN
- See Bags.fm fee share redirected to a treasury wallet and fees claimed
- See SOL swapped to USDC via Jupiter and top 100 holders resolved for any token mint
- See fund instances persisted in a PostgreSQL database with full state tracking
- See the outbound flow work end-to-end: reflection claim → Jupiter swap → deBridge bridge → USDC arrives on Base

### Entry point / environment

- Entry point: CLI scripts and test harnesses for each subsystem proof
- Environment: local dev + Solana mainnet + Base mainnet (real chains, small amounts)
- Live dependencies involved: Bags.fm API, deBridge DLN API, Alvara factory contracts, Jupiter Aggregator, Helius RPC

## Completion Class

- Contract complete means: each subsystem has a working TypeScript module that can be called programmatically with real chain interactions
- Integration complete means: the outbound pipeline (S06) proves subsystems wire together end-to-end
- Operational complete means: none for this milestone — operational concerns (retry, monitoring, scheduling) come in M002/M003

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A BSKT exists on Alvara's Base deployment created by our code, with real constituent tokens
- USDC moved from a Solana wallet to a Base wallet via deBridge with a verifiable tx hash on both chains
- A Bags.fm token's fee share was reconfigured programmatically and fees were claimed to a treasury wallet
- The outbound pipeline ran end-to-end: SOL claimed → swapped to USDC → bridged to Base → USDC confirmed

## Risks and Unknowns

- **Alvara factory contracts may be upgradeable proxies** — the reverse-engineered addresses could change. Need to identify proxy patterns and implementation slots.
- **Alvara's MEV-protected backend signing** — rebalancing and redemption go through a backend that computes swap routes and signs tx data. Direct contract interaction may work for creation but fail for operations that require this backend. Need to determine if we can bypass it or must replicate it.
- **Bags SDK fee share admin endpoints may require specific auth scopes** — the SDK's agent auth flow uses Moltbook verification. Not all endpoints may be accessible with a standard API key.
- **deBridge DLN on Base is relatively new** — while deBridge supports Base, the Solana↔Base route may have lower maker liquidity than established routes. Large transfers may face fill delays.
- **Solana RPC holder resolution for tokens with many holders** — getProgramAccounts with data size filters can be slow or rate-limited on public RPC endpoints. Helius may be required.

## Existing Codebase / Prior Art

- Empty repository — no existing code
- Alvara Protocol GitHub: 6 repos, only ALVA token contract and docs are public. No factory source.
- ALVA token on Base: `0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb`
- ALVA token on Ethereum: `0x8e729198d1C59B82bd6bBa579310C40d740A11C2`
- Alvara BSKT Lab live at: `bskt.alvara.xyz`
- deBridge DLN API docs: `docs.debridge.com`
- Bags SDK API docs: `docs.bags.fm`
- ERC-7621 EIP: `eips.ethereum.org/EIPS/eip-7621`

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R006 — Alvara factory contract discovery is the highest-risk item in this milestone
- R007 — BSKT creation via factory proves the discovery worked
- R005 — deBridge outbound bridge is the second highest-risk item
- R002 — Bags SDK fee share redirection validates the reflection capture path
- R004 — Jupiter swap and R013 holder resolution are lower risk but need verification
- R001 — Fund data model provides the persistence layer everything else writes to

## Scope

### In Scope

- Alvara factory contract reverse-engineering from on-chain data (Base + Ethereum)
- Programmatic BSKT creation on Base via discovered factory
- deBridge DLN Solana→Base USDC transfer
- Bags SDK fee share configuration and fee claiming
- Jupiter SOL→USDC swap
- Solana RPC top 100 holder resolution
- PostgreSQL fund data model and state persistence
- End-to-end outbound subsystem integration proof

### Out of Scope / Non-Goals

- Alvara rebalancing or redemption (M002/M003)
- Return bridge (EVM→Solana) — deferred to M003
- Distribution to holders — deferred to M003
- Frontend/UI — deferred to M004
- Auto-divestment triggers — deferred to M003
- Multi-fund orchestration / BullMQ — deferred to M003
- On-chain divestment config contract — deferred to M002

## Technical Constraints

- All chain interactions use real mainnet (Solana + Base + Ethereum) with small test amounts
- deBridge orders must be submitted within 30 seconds of API response
- Alvara BSKT creation requires minimum 0.1 ETH seed
- Bags SDK rate limit: 1,000 requests/hour per API key
- Bags SDK agent auth requires Moltbook verification for initial JWT (365-day token)

## Integration Points

- **Bags.fm API** — fee share configuration, fee claiming, agent auth
- **Helius RPC** — Solana transaction submission, holder resolution
- **Jupiter Aggregator** — SOL→USDC swap routing and execution
- **deBridge DLN** — cross-chain order creation and monitoring
- **Alvara factory contracts** — BSKT deployment on Base/Ethereum
- **PostgreSQL** — fund state persistence

## Open Questions

- **Can Alvara BSKTs be created by direct contract call without their frontend?** — High confidence yes based on ERC-7621 standard, but the MEV protection backend signing is a question mark for creation. Likely only needed for swaps within creation, which the factory handles internally.
- **What is the factory contract address on Base?** — Must be discovered by inspecting BSKT creation transactions on bskt.alvara.xyz. Base deployment is only 4 days old (April 2, 2026).
- **Does Bags SDK agent auth work for fee-share admin endpoints?** — The admin endpoints (POST /fee-share/admin/update-config) may require elevated permissions beyond standard API keys.
- **What's the Helius rate limit for getProgramAccounts?** — Needed for holder resolution. May need a dedicated Helius plan for production use.

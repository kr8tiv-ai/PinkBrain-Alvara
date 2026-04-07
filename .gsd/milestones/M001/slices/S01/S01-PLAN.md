# S01: Alvara Factory Discovery & BSKT Proof

**Goal:** Discover Alvara's factory contract on Base from public on-chain data and prove programmatic BSKT creation works via standard contract calls
**Demo:** After this: A BSKT exists on Alvara's Base deployment created programmatically via the discovered factory contract, verifiable on Basescan

## Tasks
- [x] **T01: Scaffold project and discover Alvara factory contract on Base** — Initialize the TypeScript project from scratch and write the factory discovery script that looks up Alvara's BSKT factory contract address from public on-chain data via Basescan. Identify the factory's public interface, detect proxy patterns, and persist findings to a JSON config consumed by T02 and all downstream integration work.
  - Estimate: 2h
  - Files: package.json, tsconfig.json, .env.example, .gitignore, src/config/chains.ts, src/utils/basescan.ts, src/utils/proxy.ts, scripts/discover-factory.ts, src/config/discovered-contracts.json
  - Verify: npm install completes without errors AND npx tsx scripts/discover-factory.ts exits 0 with JSON containing factoryAddress (valid 0x address) AND cat src/config/discovered-contracts.json contains factoryAddress, abi (non-empty), isProxy (boolean), chainId (8453)
- [x] **T02: Create BSKT on Base via factory and verify ERC-7621 compliance** — Using T01's discovered factory address and ABI, write the BSKT creation script and ERC-7621 verification module. Call the factory's public interface to create a basket. If the MEV protection layer requires backend-signed parameters, analyze recent successful creation transactions to understand the signing flow and document a clean integration path. Both success and MEV-documented outcomes are valid proof for this slice.
  - Estimate: 2h
  - Files: src/alvara/factory.ts, src/alvara/erc7621.ts, scripts/create-bskt.ts, scripts/verify-bskt.ts, src/config/mev-findings.json
  - Verify: npx tsx scripts/create-bskt.ts exits 0 with bsktAddress+txHash OR exits 1 with src/config/mev-findings.json containing mevRequired:true and integration recommendation AND if BSKT created: npx tsx scripts/verify-bskt.ts verifies ERC-7621 compliance AND src/config/mev-findings.json exists with structured findings

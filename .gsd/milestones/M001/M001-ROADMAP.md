# M001: Risk Retirement & Subsystem Proof

## Vision
Prove every critical subsystem works independently — Alvara factory discovery and BSKT creation, deBridge cross-chain bridging, Bags SDK fee share capture, Jupiter swaps, holder resolution — then wire the outbound path end-to-end.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Alvara Factory Discovery & BSKT Proof | high | — | ✅ | A BSKT exists on Alvara's Base deployment created programmatically via the discovered factory contract, verifiable on Basescan |
| S02 | deBridge Solana→Base Bridge Proof | high | — | ⬜ | USDC bridged from Solana to Base via deBridge DLN API with verifiable tx hashes on both chains |
| S03 | Bags SDK Fee Share & Reflection Claiming | medium | — | ⬜ | Fee share for a test token redirected to a treasury wallet and accumulated fees claimed via Bags SDK |
| S04 | Jupiter Swap & Holder Resolution | low | — | ⬜ | SOL swapped to USDC via Jupiter and top 100 holders resolved for an arbitrary SPL token mint |
| S05 | Fund Backend & Data Model | low | S01, S02, S03, S04 | ⬜ | PostgreSQL-backed service persisting fund instances with full state tracking, connected to all subsystem modules |
| S06 | Outbound Subsystem Integration | medium | S05 | ⬜ | End-to-end outbound flow: claim reflection → Jupiter swap to USDC → deBridge bridge to Base → USDC confirmed on Base |

---
depends_on: [M001, M002, M003]
---

# M004: App Store Launch

**Gathered:** 2026-04-06
**Status:** Ready for planning

## Project Description

M004 wraps the working backend pipeline (M001-M003) in a Bags.fm-embedded frontend. Fund creation wizard, management dashboard, public performance views, failure notifications, and the Bags.fm app store submission. The UI must feel native to Bags.fm — seamless, very clean, branded consistently with the platform.

## Why This Milestone

The backend pipeline works. But without a UI, only developers can use it. M004 makes the product accessible to any Bags.fm token creator and provides transparency for holders. The app store listing drives adoption.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open the PinkBrain Alvara Fund app within Bags.fm
- Walk through a multi-step wizard to create a fund (select token → configure basket → set divestment config → review → sign)
- Monitor their fund's status, pipeline history, and basket performance in a clean management dashboard
- Trigger rebalancing and emergency controls through the dashboard (leaning on Alvara for basket management)
- View any fund's performance, composition, and distribution history without authentication
- Receive email alerts when pipeline operations fail
- Verify every transaction on-chain via linked explorer hashes

### Entry point / environment

- Entry point: Bags.fm app store embedded application
- Environment: React + Next.js frontend, Node.js API backend
- Live dependencies: Bags.fm app store embed format, Bags.fm auth, all M001-M003 backend services

## Completion Class

- Contract complete means: all UI flows work with the M003 backend API
- Integration complete means: embedded app works inside Bags.fm app store
- Operational complete means: email notifications fire on failures, public views load without auth
- UAT complete means: a token creator can complete the full flow from Bags.fm

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A token creator can create a fund through the Bags.fm embedded app, from start to first accumulation cycle
- The dashboard accurately reflects real-time fund state and pipeline status
- Public performance views load without authentication and show correct data
- Email notifications fire when pipeline operations fail
- The UI matches Bags.fm branding — feels native, very clean, not a foreign embed
- Anti-rug protections are visible: immutable config displayed, all tx hashes linked, on-chain verification paths clear

## Risks and Unknowns

- **Bags.fm app store embed format** — not documented. Could be iframe, custom SDK, or something else. Need to investigate their existing app store apps for patterns.
- **Wallet connection in embedded context** — the fund creation wizard requires the token creator to sign a transaction (fee share redirect). Wallet adapters (Phantom, Solflare) must work within the Bags.fm embed.
- **Bags.fm branding assets** — need access to their design system, color palette, typography, and component patterns to match the look.
- **App store submission requirements** — unknown what metadata, screenshots, or review process Bags.fm requires.

## Existing Codebase / Prior Art

- M001-M003 deliverables: complete backend with REST API for all fund operations
- Bags.fm website at bags.fm — design reference for branding consistency

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions.

## Relevant Requirements

- R022 — Bags.fm embedded app UI
- R023 — Dashboard + email failure notifications
- R027 — Complete audit trail in UI
- R018 — On-chain verifiability displayed in UI

## Scope

### In Scope

- Multi-step fund creation wizard (token → basket → divestment → review → sign)
- Management dashboard (fund status, pipeline history, rebalance trigger, emergency stables)
- Public fund performance view (no auth, accessible to anyone)
- Distribution history view
- Email notification system (SendGrid or similar) for pipeline failures
- Complete audit trail UI (all tx hashes linked to Solscan, Basescan, Etherscan, deBridge explorer)
- Anti-rug transparency (immutable config displayed prominently, on-chain verification links)
- Bags.fm app store submission
- Bags.fm-native branding — seamless, very clean

### Out of Scope / Non-Goals

- Custom staking UI (R031 out of scope)
- Auto-rebalance scheduling UI (R029 deferred)
- Basket templates (R030 deferred)
- Mobile app (web-embedded only)
- Alvara management features beyond what we've already built (rebalance + emergency)

## Technical Constraints

- Must match Bags.fm branding — not a standalone aesthetic (D017)
- Anti-rug/anti-game protections must be visible in UI (D018)
- Wallet connection must work in Bags.fm embedded context
- Public views load without authentication
- Email alerts require SMTP/API integration (SendGrid recommended)

## Integration Points

- **Bags.fm app store** — embed format, auth flow, submission process
- **M001-M003 REST API** — all fund CRUD, pipeline status, rebalancing, distribution history
- **Wallet adapters** — Phantom, Solflare for transaction signing in embedded context
- **Block explorers** — Solscan, Basescan, Etherscan, deBridge explorer for tx hash links
- **Email service** — SendGrid or similar for failure notifications

## Open Questions

- **Bags.fm embed format** — iframe? Custom SDK? Web component? Need to inspect existing app store apps.
- **Bags.fm design system** — Is there a public component library, or do we screenshot and replicate?
- **App store review process** — Is there a review/approval step before the app goes live?
- **Wallet adapter compatibility** — Do standard Solana wallet adapters work inside an iframe? May need postMessage bridges.

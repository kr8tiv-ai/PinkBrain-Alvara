# M001 Discussion Log

## Exchange — 2026-04-07T04:52:46.183Z

### M002

M002 (Outbound Pipeline: Solana → Alvara) — I wrote a draft context capturing what we discussed. How do you want to handle this milestone?

- **Write draft for later (Recommended)** — Draft context is saved. When auto-mode reaches M002, it pauses for a dedicated discussion.
- **Discuss now** — Conduct a focused discussion for M002 right now while context is fresh.
- **Just queue it** — No context saved — full discussion from scratch when M001 finishes.

**Selected:** Discuss now

---
## Exchange — 2026-04-07T04:53:53.958Z

### Scheduler

For monitoring reflection accumulation across all active funds: a single cron job that polls all funds every N hours is simpler, but a per-fund timer gives each fund independent scheduling. I’d lean single cron (simpler, fewer moving parts) — agree?

- **Single cron polling all funds (Recommended)** — One scheduled job iterates over all active funds, checks thresholds, triggers pipelines
- **Per-fund timers** — Each fund gets its own BullMQ repeatable job with independent scheduling

**Selected:** Single cron polling all funds (Recommended)

### Fund lifecycle

Can a fund go through multiple divestment cycles (accumulate → invest → divest → distribute → repeat), or is divestment a one-time terminal event that shuts the fund down?

- **Repeating cycles (Recommended)** — Fund accumulates, invests, divests, distributes, then starts accumulating again — ongoing
- **One-time terminal** — Divestment shuts the fund down permanently. Creator must create a new fund to start again.

**Selected:** Repeating cycles (Recommended)

---
## Exchange — 2026-04-07T04:55:07.143Z

### Config contract

For the on-chain divestment config: one registry contract per chain that stores configs for all funds is cleaner than deploying a separate config contract per fund. The registry maps fund ID → immutable config struct. Cheaper gas, single source of truth. Sound right?

- **Single registry per chain (Recommended)** — One contract on Base, one on Ethereum — maps fund ID to immutable divestment config
- **Per-fund config contracts** — Each fund deploys its own config contract — more isolated but more gas and complexity

**Selected:** Single registry per chain (Recommended)

### Rebalancing

Alvara’s rebalance goes through their MEV-protected backend. When the fund owner triggers a rebalance from our app, should we route through Alvara’s frontend/API (if discoverable) or attempt direct contract calls (may lose MEV protection)?

- **Attempt direct contract calls first** — Try direct rebalance via the ERC-7621 contract. If Alvara’s backend signing is required, we’ll discover that in M001/S01.
- **Route through Alvara’s interface** — Reverse-engineer their backend API calls from the frontend to replicate the signed flow

**Selected:** Route through Alvara’s interface

---
## Exchange — 2026-04-07T04:55:46.454Z

### Failure mode

If the outbound pipeline fails partway through (e.g., swap succeeded but bridge failed): should the system retry from the exact failed step (resume), or roll back to the beginning of the cycle and start fresh?

- **Resume from failed step (Recommended)** — Each pipeline step is checkpointed. On failure, retry from the last failed step. No wasted gas on completed steps.
- **Start fresh** — On any failure, abort the cycle and try the whole pipeline again next polling interval

**Selected:** Resume from failed step (Recommended)

### M002 Check

For M002: automated accumulation with single cron, repeating fund cycles, single registry contract per chain, Alvara interface routing for rebalance, resume-from-failure recovery. Does this capture M002 correctly?

- **Yes, write the full context (Recommended)** — Write the full M002 CONTEXT.md and move to M003 gate
- **Not quite — let me clarify** — Something’s off about M002 scope

**Selected:** Yes, write the full context (Recommended)

---
## Exchange — 2026-04-07T04:57:30.644Z

### M003

M003 (Return Pipeline & Distribution) — auto-divestment triggers, Alvara redemption, return bridge, holder distribution. How do you want to handle this milestone?

- **Write draft for later (Recommended)** — Draft context captures what we discussed. Dedicated discussion when M002 finishes.
- **Discuss now** — Conduct a focused discussion for M003 right now.
- **Just queue it** — No context — full discussion from scratch when M002 finishes.

**Selected:** Discuss now

---
## Exchange — 2026-04-07T04:58:12.513Z

### Snapshot

When the auto-divestment trigger fires, the holder snapshot determines who gets paid. Should the snapshot be taken at trigger time (before redemption + bridge, which could take minutes), or at actual distribution time (after funds arrive on Solana)?

- **At trigger time (Recommended)** — Snapshot locked when divestment fires. Prevents gaming by buying tokens during the bridge delay.
- **At distribution time** — Most current holder data, but creates a window where people can buy in after seeing the trigger.

**Selected:** At trigger time (Recommended)

### Minimum

Should there be a minimum basket value below which auto-divestment is skipped (because gas + bridge fees would eat the proceeds)?

- **Yes, configurable minimum (Recommended)** — If basket TVL is below a threshold (e.g., $50), skip divestment and keep accumulating
- **No minimum — always divest** — Always execute divestment when triggered, even if proceeds are small

**Selected:** Yes, configurable minimum (Recommended)

---
## Exchange — 2026-04-07T04:59:25.229Z

### Partial fail

If distribution to 100 holders partially fails (e.g., 80 succeed, 20 fail due to closed accounts), what should happen?

- **Retry failed, hold remainder (Recommended)** — Successful distributions are final. Failed ones retry 3x. Unclaimed remainder held in treasury for manual resolution.
- **All or nothing** — If any distribution fails, roll back all and retry the entire batch.

**Selected:** None of the above
**Notes:** we should add solana and immediately verify, fix and the verify that result

### M003 Check

For M003: snapshot at trigger time, configurable minimum divestment threshold, retry failed distributions with remainder held for resolution, repeating fund cycles. Correct?

- **Yes, write the full context (Recommended)** — Write the full M003 CONTEXT.md and move to M004 gate
- **Not quite — let me clarify** — Something’s off about M003 scope

**Selected:** Yes, write the full context (Recommended)

---
## Exchange — 2026-04-07T05:00:36.715Z

### M004

M004 (App Store Launch) — Bags.fm embedded UI, dashboard, notifications, audit trail. How do you want to handle this milestone?

- **Write draft for later (Recommended)** — Draft context captures what we discussed. Dedicated discussion when M003 finishes.
- **Discuss now** — Conduct a focused discussion for M004 right now.
- **Just queue it** — No context — full discussion from scratch when M003 finishes.

**Selected:** Discuss now

---
## Exchange — 2026-04-07T05:01:19.963Z

### Setup UX

The fund creation wizard needs the token creator to: connect wallet, select their token, configure basket composition, set divestment config, choose chain + distribution currency, and sign the fee share redirect tx. Should this be a multi-step wizard or a single-page form?

- **Multi-step wizard (Recommended)** — Guided steps: Token → Basket Config → Divestment Config → Review → Sign. Clearer for complex setup.
- **Single-page form** — Everything on one page with sections. Faster for experienced users but potentially overwhelming.

**Selected:** Multi-step wizard (Recommended)

### Public access

Should the public fund performance view (any user can see fund metrics, composition, distribution history) require Bags.fm authentication, or be accessible to anyone?

- **Public, no auth required (Recommended)** — Transparency maximized — anyone with the link can view fund performance and audit trail
- **Bags.fm auth required** — Only Bags.fm users can view fund details

**Selected:** Public, no auth required (Recommended)

---
## Exchange — 2026-04-07T05:02:46.851Z

### Dashboard

The management dashboard for fund owners — how interactive should it be? Just rebalancing and emergency controls (which we already have via API), or also things like adjusting accumulation threshold and shutting down a fund?

- **Full management (Recommended)** — Rebalance, emergency stables, adjust accumulation threshold, pause/resume fund, shutdown fund
- **Core controls only** — Just rebalance and emergency stables — everything else via API or locked at creation

**Selected:** None of the above
**Notes:** we should make sure it can't be rugged or gamed and use alvara as much as possible keeping the UI seamless and branded the same as the bags.fm website and app store.  It should be very clean.

### M004 Check

For M004: multi-step creation wizard, public performance views with no auth, full management dashboard, email notifications for failures, Bags.fm embedded. Correct?

- **Yes, write the full context (Recommended)** — Write the full M004 CONTEXT.md and finalize all milestones
- **Not quite — let me clarify** — Something’s off about M004 scope

**Selected:** Yes, write the full context (Recommended)

---

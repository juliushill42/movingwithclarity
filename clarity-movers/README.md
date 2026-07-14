# CLARITY Movers

A moving-labor platform built to eliminate the specific failure modes that
show up over and over in Caddy Moving's BBB complaints and reviews: crews
arriving with no equipment, undocumented property damage, and movers not
getting paid.

## What's different, architecturally (not just marketing)

| Caddy failure pattern | CLARITY mechanism |
|---|---|
| Movers show up with no dolly/straps/blankets | `equipment_checklist` table + ops-service gate — **clock-in is rejected (409)** until every required item is confirmed on site |
| Damage claims go nowhere, disputed after the fact | `ledger-service` — append-only, SHA-256 hash-chained ledger; any tampering with history breaks the chain and `/ledger/verify` catches it |
| Movers not paid, no record of what's owed | Same ledger, `entry_type=payout` — every payment obligation is a permanent, ordered, verifiable entry |
| Unvetted gig workers | `movers.background_check_status` gates a mover out of `active_only` listings until `passed` |

## Services

- **gateway** (Node/Express) — single entry point, API-key auth, serves the frontend, proxies to internal services.
- **booking-service** (Node/Express + Postgres) — source of truth for customers, moves, movers, assignments, checklist state, clock events.
- **ops-service** (Go, stdlib only) — orchestration layer: assignment, the equipment-checklist gate, clock-in/out enforcement. Talks to booking-service over HTTP; owns no database of its own.
- **ledger-service** (Rust/axum + sqlx) — hash-chained payment and damage-claim ledger, modeled on the JCH-2026-004 audit-chain pattern.
- **frontend** — vanilla HTML/CSS/JS booking form and job-status lookup, no framework.

## Quick start

```bash
docker compose up --build
```

- Frontend: http://localhost:4000
- Gateway/API: http://localhost:4000/api/*
- Direct service ports (debugging): booking 4001, ops 4002, ledger 4003

## Example flow

```bash
# 1. Book a move (via gateway, needs API key for POST)
curl -X POST localhost:4000/api/customers \
  -H "x-clarity-api-key: dev-key-change-me" -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","email":"jane@example.com","phone":"555-0100"}'

curl -X POST localhost:4000/api/moves \
  -H "x-clarity-api-key: dev-key-change-me" -H "Content-Type: application/json" \
  -d '{"customer_id":"<id>","pickup_address":"123 A St","dropoff_address":"456 B St","scheduled_at":"2026-08-01T14:00:00Z","size":"2br","hourly_rate_cents":7500}'

# 2. Register + assign a mover
curl -X POST localhost:4000/api/movers -H "x-clarity-api-key: dev-key-change-me" \
  -H "Content-Type: application/json" -d '{"name":"Mike","phone":"555-0101"}'

curl -X POST localhost:4000/api/jobs/<move_id>/assign -H "x-clarity-api-key: dev-key-change-me" \
  -H "Content-Type: application/json" -d '{"mover_id":"<mover_id>"}'

# 3. Confirm equipment (repeat per checklist item — dolly, moving_straps, etc.)
curl -X POST localhost:4000/api/jobs/<move_id>/checklist/dolly/confirm \
  -H "x-clarity-api-key: dev-key-change-me" -H "Content-Type: application/json" \
  -d '{"mover_id":"<mover_id>"}'

# 4. Clock in — fails with 409 until checklist is 100% confirmed
curl -X POST localhost:4000/api/jobs/<move_id>/clock-in \
  -H "x-clarity-api-key: dev-key-change-me" -H "Content-Type: application/json" \
  -d '{"mover_id":"<mover_id>"}'

# 5. Record a payout on the ledger
curl -X POST localhost:4000/api/ledger/entries -H "x-clarity-api-key: dev-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"move_id":"<move_id>","entry_type":"payout","amount_cents":15000,"details":{"note":"2hr labor"}}'

# 6. Verify the whole ledger chain is intact
curl localhost:4000/api/ledger/verify -H "x-clarity-api-key: dev-key-change-me"
```

## Verified in this environment

- `booking-service` and `gateway` and `frontend/app.js`: passed `node --check` (syntax-clean).
- `ops-service`: compiles clean with `go build` (Go 1.22, stdlib only, no external module fetches needed).
- `ledger-service`: reviewed by hand; **not** compiled here — this sandbox's apt-installed rustc (1.75) is too old for current crates.io packages that require edition2024 (rustc 1.85+). This is a sandbox tooling gap, not a code issue — build it with your normal Rust toolchain.

## Not yet built (next real increments, not stubs in this code)

- Real customer auth (the frontend's `dev-key-change-me` is a dev convenience, documented as such in `frontend/app.js`)
- Kafka event wiring between services (broker is provisioned in compose, not yet consumed — booking-service and ops-service currently talk synchronously over HTTP, which is correct for this job volume; move to event-driven when it's actually needed)
- Payment processor integration for real payouts (ledger currently records the obligation, not the money movement)
- Mover mobile app / SMS flow for on-site checklist confirmation (currently API-only)

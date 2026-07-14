-- CLARITY Movers — core schema
-- Every table here exists to close a specific failure mode observed in the
-- labor-moving market (missing equipment, undocumented damage, unpaid movers).

-- Multi-tenant: each licensed mover/broker org is a tenant. All customer-
-- facing data is scoped by tenant_id so tenants can't see each other's data.
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default tenant for the CLARITY-operated site itself.
INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'CLARITY Movers', 'clarity')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, email)
);

CREATE TABLE IF NOT EXISTS movers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    background_check_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (background_check_status IN ('pending', 'passed', 'failed')),
    rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    customer_id UUID NOT NULL REFERENCES customers(id),
    pickup_address TEXT NOT NULL,
    dropoff_address TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    size TEXT NOT NULL CHECK (size IN ('studio','1br','2br','3br','4br_plus')),
    stairs_flights INTEGER NOT NULL DEFAULT 0,
    truck_size TEXT NOT NULL DEFAULT 'not_needed'
        CHECK (truck_size IN ('not_needed','10ft','15ft','20ft','26ft')),
    special_instructions TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'booked'
        CHECK (status IN ('booked','assigned','equipment_checked','in_progress','completed','cancelled')),
    hourly_rate_cents INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    move_id UUID NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
    mover_id UUID NOT NULL REFERENCES movers(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(move_id, mover_id)
);

-- The equipment gate: a move cannot clock in until every required item is
-- confirmed present by a mover on site. This directly targets the "showed up
-- with no dolly/straps/blankets" failure pattern.
CREATE TABLE IF NOT EXISTS equipment_checklist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    move_id UUID NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    confirmed BOOLEAN NOT NULL DEFAULT false,
    confirmed_by UUID REFERENCES movers(id),
    confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clock_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    move_id UUID NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
    mover_id UUID NOT NULL REFERENCES movers(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('clock_in','clock_out')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, hash-chained ledger. Mirrors the JCH-2026-004 audit-chain
-- pattern: every entry commits to the hash of the previous entry so payment
-- and damage-claim history can't be silently edited after the fact.
CREATE TABLE IF NOT EXISTS ledger_entries (
    seq BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    move_id UUID NOT NULL REFERENCES moves(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('payment','damage_claim','refund','payout')),
    amount_cents INTEGER NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moves_status ON moves(status);
CREATE INDEX IF NOT EXISTS idx_ledger_move ON ledger_entries(move_id);
CREATE INDEX IF NOT EXISTS idx_checklist_move ON equipment_checklist(move_id);
CREATE INDEX IF NOT EXISTS idx_moves_tenant ON moves(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_movers_tenant ON movers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_seq ON ledger_entries(tenant_id, seq);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

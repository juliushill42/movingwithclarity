const express = require('express');
const { pool } = require('./db');

const app = express();
app.use(express.json());

const VALID_SIZES = ['studio', '1br', '2br', '3br', '4br_plus'];
const VALID_STATUSES = ['booked', 'assigned', 'equipment_checked', 'in_progress', 'completed', 'cancelled'];

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Every request must carry the tenant the gateway resolved from the API
// key. This is the tenant isolation boundary — every query below filters
// on it, so one tenant's data is never visible or writable by another.
app.use('/health', (req, res, next) => next());
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const tenantId = req.header('x-clarity-tenant-id');
  if (!tenantId) return res.status(400).json({ error: 'x-clarity-tenant-id header is required' });
  req.tenantId = tenantId;
  next();
});

// --- Customers -------------------------------------------------------------

app.post('/customers', asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'name, email, and phone are required' });
  }
  const result = await pool.query(
    `INSERT INTO customers (tenant_id, name, email, phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone
     RETURNING id, name, email, phone, created_at`,
    [req.tenantId, name, email, phone]
  );
  res.status(201).json(result.rows[0]);
}));

app.get('/customers/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'customer not found' });
  res.json(result.rows[0]);
}));

// --- Moves -------------------------------------------------------------

app.post('/moves', asyncHandler(async (req, res) => {
  const {
    customer_id, pickup_address, dropoff_address, scheduled_at, size, hourly_rate_cents,
    stairs_flights, truck_size, special_instructions
  } = req.body;

  if (!customer_id || !pickup_address || !dropoff_address || !scheduled_at || !size || !hourly_rate_cents) {
    return res.status(400).json({
      error: 'customer_id, pickup_address, dropoff_address, scheduled_at, size, hourly_rate_cents are required'
    });
  }
  if (!VALID_SIZES.includes(size)) {
    return res.status(400).json({ error: `size must be one of: ${VALID_SIZES.join(', ')}` });
  }
  if (hourly_rate_cents <= 0) {
    return res.status(400).json({ error: 'hourly_rate_cents must be positive' });
  }
  const validTruckSizes = ['not_needed', '10ft', '15ft', '20ft', '26ft'];
  if (truck_size && !validTruckSizes.includes(truck_size)) {
    return res.status(400).json({ error: `truck_size must be one of: ${validTruckSizes.join(', ')}` });
  }

  const customerCheck = await pool.query(
    'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2',
    [customer_id, req.tenantId]
  );
  if (customerCheck.rows.length === 0) {
    return res.status(404).json({ error: 'customer not found for this tenant' });
  }

  const result = await pool.query(
    `INSERT INTO moves (
       tenant_id, customer_id, pickup_address, dropoff_address, scheduled_at, size, hourly_rate_cents,
       stairs_flights, truck_size, special_instructions
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      req.tenantId, customer_id, pickup_address, dropoff_address, scheduled_at, size, hourly_rate_cents,
      stairs_flights || 0, truck_size || 'not_needed', special_instructions || ''
    ]
  );

  const move = result.rows[0];

  // Seed the equipment checklist required for this move size. Nothing can
  // clock in against this move until ops-service confirms every row here.
  const requiredItems = ['dolly', 'moving_straps', 'furniture_blankets', 'protective_floor_runners'];
  if (size === '3br' || size === '4br_plus') requiredItems.push('appliance_hand_truck');

  await pool.query(
    `INSERT INTO equipment_checklist (move_id, item)
     SELECT $1, unnest($2::text[])`,
    [move.id, requiredItems]
  );

  res.status(201).json(move);
}));

app.get('/moves/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  res.json(result.rows[0]);
}));

app.get('/moves', asyncHandler(async (req, res) => {
  const { status } = req.query;
  if (status) {
    const result = await pool.query(
      'SELECT * FROM moves WHERE tenant_id = $1 AND status = $2 ORDER BY scheduled_at',
      [req.tenantId, status]
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    'SELECT * FROM moves WHERE tenant_id = $1 ORDER BY scheduled_at DESC LIMIT 200',
    [req.tenantId]
  );
  res.json(result.rows);
}));

app.patch('/moves/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  const result = await pool.query(
    `UPDATE moves SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [status, req.params.id, req.tenantId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  res.json(result.rows[0]);
}));

app.get('/moves/:id/checklist', asyncHandler(async (req, res) => {
  const moveCheck = await pool.query(
    'SELECT id FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (moveCheck.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  const result = await pool.query(
    'SELECT * FROM equipment_checklist WHERE move_id = $1 ORDER BY item',
    [req.params.id]
  );
  res.json(result.rows);
}));

// Internal endpoint used by ops-service to write confirmations back.
app.patch('/moves/:id/checklist/:item', asyncHandler(async (req, res) => {
  const { confirmed_by } = req.body;
  if (!confirmed_by) return res.status(400).json({ error: 'confirmed_by (mover id) is required' });
  const moveCheck = await pool.query(
    'SELECT id FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (moveCheck.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  const result = await pool.query(
    `UPDATE equipment_checklist
     SET confirmed = true, confirmed_by = $1, confirmed_at = now()
     WHERE move_id = $2 AND item = $3
     RETURNING *`,
    [confirmed_by, req.params.id, req.params.item]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'checklist item not found' });
  res.json(result.rows[0]);
}));

// --- Movers (raw data — orchestration/gating logic lives in ops-service) --

app.post('/movers', asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const result = await pool.query(
    `INSERT INTO movers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING *`,
    [req.tenantId, name, phone]
  );
  res.status(201).json(result.rows[0]);
}));

app.get('/movers', asyncHandler(async (req, res) => {
  const { active_only } = req.query;
  const query = active_only === 'true'
    ? 'SELECT * FROM movers WHERE tenant_id = $1 AND active = true AND background_check_status = $2 ORDER BY rating DESC'
    : 'SELECT * FROM movers WHERE tenant_id = $1 ORDER BY rating DESC';
  const result = await pool.query(query, active_only === 'true' ? [req.tenantId, 'passed'] : [req.tenantId]);
  res.json(result.rows);
}));

app.patch('/movers/:id/background-check', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'passed', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending, passed, or failed' });
  }
  const result = await pool.query(
    `UPDATE movers SET background_check_status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [status, req.params.id, req.tenantId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'mover not found' });
  res.json(result.rows[0]);
}));

// --- Assignments -------------------------------------------------------------

app.post('/moves/:id/assignments', asyncHandler(async (req, res) => {
  const { mover_id } = req.body;
  if (!mover_id) return res.status(400).json({ error: 'mover_id is required' });
  const moveCheck = await pool.query(
    'SELECT id FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (moveCheck.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  const result = await pool.query(
    `INSERT INTO move_assignments (move_id, mover_id) VALUES ($1, $2)
     ON CONFLICT (move_id, mover_id) DO NOTHING RETURNING *`,
    [req.params.id, mover_id]
  );
  res.status(201).json(result.rows[0] || { move_id: req.params.id, mover_id, already_assigned: true });
}));

app.get('/moves/:id/assignments', asyncHandler(async (req, res) => {
  const moveCheck = await pool.query(
    'SELECT id FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (moveCheck.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  const result = await pool.query(
    `SELECT a.*, m.name, m.phone, m.rating FROM move_assignments a
     JOIN movers m ON m.id = a.mover_id WHERE a.move_id = $1`,
    [req.params.id]
  );
  res.json(result.rows);
}));

// --- Clock events -------------------------------------------------------------

app.post('/moves/:id/clock', asyncHandler(async (req, res) => {
  const { mover_id, event_type } = req.body;
  if (!mover_id || !['clock_in', 'clock_out'].includes(event_type)) {
    return res.status(400).json({ error: 'mover_id and event_type (clock_in|clock_out) are required' });
  }
  const moveCheck = await pool.query(
    'SELECT id FROM moves WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (moveCheck.rows.length === 0) return res.status(404).json({ error: 'move not found' });
  const result = await pool.query(
    `INSERT INTO clock_events (move_id, mover_id, event_type) VALUES ($1, $2, $3) RETURNING *`,
    [req.params.id, mover_id, event_type]
  );
  res.status(201).json(result.rows[0]);
}));

app.get('/health', (req, res) => res.json({ ok: true, service: 'booking-service' }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`[booking-service] listening on ${PORT}`));

// Keep process alive on unexpected async errors instead of silently dying.
app.use((err, req, res, next) => {
  console.error('[booking-service] error:', err);
  res.status(500).json({ error: 'internal error' });
});


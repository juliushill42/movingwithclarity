const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgres://clarity:clarity@postgres:5432/clarity',
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('[booking-service] unexpected pg pool error', err);
});

module.exports = { pool };

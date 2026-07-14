const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();

const BOOKING_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:4001';
const OPS_URL = process.env.OPS_SERVICE_URL || 'http://ops-service:4002';
const LEDGER_URL = process.env.LEDGER_SERVICE_URL || 'http://ledger-service:4003';
const CHAT_URL = process.env.CHAT_SERVICE_URL || 'http://chat-service:4004';

// API keys are declared as "key:tenant_id" pairs, comma-separated, e.g.
// CLARITY_API_KEYS="dev-key-change-me:00000000-0000-0000-0000-000000000001,acme-key:<acme-tenant-uuid>"
// A bare key with no ":tenant_id" is rejected — every tenant must be explicit.
// Every /api request must carry a valid key: with tenant scoping, an
// unauthenticated GET has no tenant to scope to, so it can't be served.
const API_KEY_TENANTS = new Map(
  (process.env.CLARITY_API_KEYS || 'dev-key-change-me:00000000-0000-0000-0000-000000000001')
    .split(',')
    .map((pair) => pair.split(':'))
    .filter(([key, tenantId]) => key && tenantId)
);

app.use((req, res, next) => {
  const key = req.header('x-clarity-api-key');
  const tenantId = key && API_KEY_TENANTS.get(key);
  if (!tenantId) {
    return res.status(401).json({ error: 'missing or invalid x-clarity-api-key header' });
  }
  req.headers['x-clarity-tenant-id'] = tenantId;
  next();
});

app.use('/api/customers', createProxyMiddleware({ target: BOOKING_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));
app.use('/api/moves', createProxyMiddleware({ target: BOOKING_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));
app.use('/api/movers', createProxyMiddleware({ target: BOOKING_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));
app.use('/api/jobs', createProxyMiddleware({ target: OPS_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));
app.use('/api/ledger', createProxyMiddleware({ target: LEDGER_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));
app.use('/api/chat', createProxyMiddleware({ target: CHAT_URL, changeOrigin: true, pathRewrite: { '^/api': '' } }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'gateway' }));

app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`[gateway] listening on ${PORT}`));

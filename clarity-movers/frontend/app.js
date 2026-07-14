// Dev-mode API key. In production this comes from an authenticated
// customer session, not a hardcoded constant — swap this for real auth
// before this ships publicly.
const API_KEY = 'dev-key-change-me';

async function callApi(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-clarity-api-key': API_KEY,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

document.getElementById('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById('booking-result');
  resultEl.textContent = 'Booking...';

  try {
    const customer = await callApi('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value
      })
    });

    const move = await callApi('/moves', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        pickup_address: document.getElementById('pickup').value,
        dropoff_address: document.getElementById('dropoff').value,
        scheduled_at: new Date(document.getElementById('scheduled_at').value).toISOString(),
        size: document.getElementById('size').value,
        stairs_flights: parseInt(document.getElementById('stairs').value, 10) || 0,
        truck_size: document.getElementById('truck_size').value,
        special_instructions: document.getElementById('special_instructions').value,
        hourly_rate_cents: 7500
      })
    });

    resultEl.textContent = `Booked! Your move ID is ${move.id} — save this to check status.`;
    document.getElementById('status-move-id').value = move.id;
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById('status-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById('status-result');
  const moveId = document.getElementById('status-move-id').value.trim();
  if (!moveId) return;

  resultEl.textContent = 'Loading...';
  try {
    const status = await callApi(`/jobs/${moveId}/status`);
    resultEl.textContent = JSON.stringify(status, null, 2);
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
  }
});

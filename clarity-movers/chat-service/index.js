// chat-service owns the customer-facing assistant. Primary backend is the
// Gemini API; if GEMINI_API_KEY is unset or the call fails, it falls back
// to the local llama.cpp inference server (ai-bridge).
const express = require('express');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://ai-bridge:8000';

const SYSTEM_CONTEXT = [
  'You are the CLARITY Movers assistant on movingwithclarity.com.',
  'CLARITY is a moving-labor platform: customers book a move with pickup/dropoff',
  'address, date, home size, and truck size; movers only clock in once the full',
  'equipment checklist is confirmed on site; payments and damage claims are',
  'recorded on a hash-chained ledger.',
  'Answer customer questions about booking a move, pricing, how the equipment',
  'checklist and ledger work, and how to check a move status by move ID.',
  'Keep answers under 4 sentences. If asked something outside moving services,',
  'say you can only help with CLARITY Movers questions.'
].join(' ');

function historyToGeminiContents(history) {
  return (history || [])
    .filter((h) => h && typeof h.text === 'string')
    .slice(-10)
    .map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }]
    }));
}

async function callGemini(message, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [...historyToGeminiContents(history), { role: 'user', parts: [{ text: message }] }],
    systemInstruction: { parts: [{ text: SYSTEM_CONTEXT }] },
    generationConfig: { maxOutputTokens: 512 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!reply) throw new Error('empty Gemini response');
  return reply;
}

async function callAiBridge(message, history) {
  const res = await fetch(`${AI_BRIDGE_URL}/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: message, system: SYSTEM_CONTEXT, history: history || [] })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ai-bridge ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.reply) throw new Error('empty ai-bridge response');
  return data.reply;
}

app.post('/chat', async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (GEMINI_API_KEY) {
    try {
      const reply = await callGemini(message, history);
      return res.json({ reply, source: 'gemini' });
    } catch (err) {
      console.error('[chat-service] Gemini error, falling back to ai-bridge:', err.message);
    }
  }

  try {
    const reply = await callAiBridge(message, history);
    return res.json({ reply, source: 'ai-bridge' });
  } catch (err) {
    console.error('[chat-service] ai-bridge error:', err.message);
    return res.status(502).json({ error: 'Sorry, chat is temporarily unavailable. Please use the booking form.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'chat-service', gemini_configured: !!GEMINI_API_KEY });
});

const PORT = process.env.PORT || 4004;
app.listen(PORT, () => console.log(`[chat-service] listening on ${PORT}`));

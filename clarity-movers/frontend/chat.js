// Collapsible chat widget. Talks to the gateway at /api/chat, which
// proxies to chat-service (Gemini, with local llama.cpp fallback).
(function () {
  const API_KEY = 'dev-key-change-me';
  const toggleBtn = document.getElementById('chat-toggle-btn');
  const closeBtn = document.getElementById('chat-close-btn');
  const container = document.getElementById('chat-container');
  const windowEl = document.getElementById('chat-window');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');

  let history = [];
  let opened = false;

  function toggleChat() {
    opened = !opened;
    container.classList.toggle('hidden', !opened);
    toggleBtn.setAttribute('aria-expanded', String(opened));
    if (opened && windowEl.childElementCount === 0) {
      appendMessage('assistant', "Hi! I'm the CLARITY assistant. Ask me about booking, pricing, or your move status.");
    }
    if (opened) input.focus();
  }

  function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role === 'user' ? 'user' : 'assistant'}`;
    const sender = role === 'user' ? 'You' : 'CLARITY';
    div.innerHTML = `<span class="sender">${sender}:</span> <span></span>`;
    div.querySelector('span:last-child').textContent = text;
    windowEl.appendChild(div);
    windowEl.scrollTop = windowEl.scrollHeight;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendMessage('user', text);
    history.push({ role: 'user', text });

    const pending = document.createElement('div');
    pending.className = 'chat-msg assistant';
    pending.innerHTML = '<span class="sender">CLARITY:</span> <span>...</span>';
    windowEl.appendChild(pending);
    windowEl.scrollTop = windowEl.scrollHeight;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clarity-api-key': API_KEY
        },
        body: JSON.stringify({ message: text, history })
      });
      const data = await res.json().catch(() => ({}));
      pending.remove();
      if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
      appendMessage('assistant', data.reply);
      history.push({ role: 'assistant', text: data.reply });
    } catch (err) {
      pending.remove();
      appendMessage('assistant', `Sorry, something went wrong (${err.message}).`);
    }
  }

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
})();

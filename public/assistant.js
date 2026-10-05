'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const model = { messages: [], lastResponded: 0, timer: null, busy: false };
  let wired = false;

  async function request(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function setAuthenticated(value) {
    const toggle = byId('assistant-toggle');
    const panel = byId('assistant-panel');
    if (!toggle || !panel) return;
    toggle.hidden = !value;
    if (!value) panel.hidden = true;
  }

  function renderMessage(role, text, sources = []) {
    const list = byId('assistant-messages');
    const item = document.createElement('div');
    item.className = `assistant-message assistant-message-${role}`;
    const body = document.createElement('div');
    body.className = 'assistant-message-body';
    body.textContent = text;
    item.appendChild(body);
    if (Array.isArray(sources) && sources.length) {
      const cite = document.createElement('div');
      cite.className = 'assistant-sources';
      cite.textContent = `Synthetic sources: ${sources.map((source) => `${source.title} — ${source.section}`).join('; ')}`;
      item.appendChild(cite);
    }
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  function setStatus(text, kind = '') {
    const status = byId('assistant-status');
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function pendingMessages() { return model.messages.slice(model.lastResponded); }

  function clearTimer() {
    if (model.timer) clearTimeout(model.timer);
    model.timer = null;
  }

  async function getResponse() {
    if (model.busy || !pendingMessages().some((message) => message.role === 'user')) return;
    clearTimer();
    model.busy = true;
    setStatus('Preparing deterministic demo response…', 'working');
    try {
      const data = await request('/api/assistant/respond', {
        method: 'POST',
        body: JSON.stringify({ messages: pendingMessages() }),
      });
      model.messages.push({ role: 'assistant', text: data.text, at: Date.now() });
      model.lastResponded = model.messages.length;
      renderMessage('assistant', data.text, data.sources || []);
      setStatus('Fallback mode · no external LLM connected', 'ready');
    } catch (err) {
      renderMessage('assistant', `I could not complete that demo response: ${err.message}`);
      setStatus('Assistant error', 'error');
    } finally {
      model.busy = false;
    }
  }

  async function evaluateTurn(force = false) {
    if (model.busy) return;
    const burst = pendingMessages();
    const latest = [...burst].reverse().find((message) => message.role === 'user');
    if (!latest) return;
    const elapsed = Math.max(0, Date.now() - latest.at);
    setStatus(force ? 'Responding now…' : 'Checking whether your turn is complete…', 'working');
    try {
      const decision = await request('/api/assistant/turn', {
        method: 'POST',
        body: JSON.stringify({ messages: burst, elapsed_ms: elapsed, force }),
      });
      if (decision.decision === 'RESPOND') return getResponse();
      setStatus(`Listening for more… (${decision.reason})`, 'waiting');
      clearTimer();
      model.timer = setTimeout(() => evaluateTurn(false), Math.max(300, Math.min(1000, decision.idle_ms || 1200)));
    } catch (err) {
      setStatus(`Turn check failed: ${err.message}`, 'error');
    }
  }

  function addUserMessage(text) {
    const message = { role: 'user', text, at: Date.now() };
    model.messages.push(message);
    renderMessage('user', text);
    clearTimer();
    evaluateTurn(false);
  }

  function wire() {
    if (wired) return;
    wired = true;
    const toggle = byId('assistant-toggle');
    const panel = byId('assistant-panel');
    const close = byId('assistant-close');
    const form = byId('assistant-form');
    const input = byId('assistant-input');
    const respondNow = byId('assistant-respond-now');
    const appMain = byId('app-main');
    if (!toggle || !panel || !close || !form || !input || !respondNow || !appMain) return;

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) input.focus();
    });
    close.addEventListener('click', () => { panel.hidden = true; });
    respondNow.addEventListener('click', () => evaluateTurn(true));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || model.busy) return;
      input.value = '';
      addUserMessage(text);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    const sync = () => setAuthenticated(!appMain.hidden);
    new MutationObserver(sync).observe(appMain, { attributes: true, attributeFilter: ['hidden'] });
    sync();
    setStatus('Fallback mode · no external LLM connected', 'ready');
    renderMessage('assistant', 'Course-demo assistant ready. Send several short messages to see turn-taking, ask a synthetic finance-process question, or ask about an accessible FR request ID.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

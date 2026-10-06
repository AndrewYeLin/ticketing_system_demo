'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const model = { messages: [], lastResponded: 0, timer: null, busy: false, config: null };
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

  function renderMessage(role, text, sources = [], tools = []) {
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
      cite.textContent = `Synthetic RAG: ${sources.map((source) => `${source.title} — ${source.section}`).join('; ')}`;
      item.appendChild(cite);
    }
    if (Array.isArray(tools) && tools.length) {
      const toolLine = document.createElement('div');
      toolLine.className = 'assistant-sources';
      toolLine.textContent = `MCP tools used: ${tools.join(', ')}`;
      item.appendChild(toolLine);
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

  function readyStatus() {
    if (model.config && model.config.provider === 'openai') {
      const mcp = model.config.mcp_enabled ? ' · MCP ready' : '';
      return `OpenAI · ${model.config.chat_model}${mcp}`;
    }
    return 'Heuristic/RAG fallback mode';
  }

  async function getResponse() {
    if (model.busy || !pendingMessages().some((message) => message.role === 'user')) return;
    clearTimer();
    model.busy = true;
    setStatus(model.config && model.config.provider === 'openai'
      ? 'Generating grounded OpenAI response…'
      : 'Preparing deterministic demo response…', 'working');
    try {
      const data = await request('/api/assistant/respond', {
        method: 'POST',
        body: JSON.stringify({ messages: pendingMessages() }),
      });
      model.messages.push({ role: 'assistant', text: data.text, at: Date.now() });
      model.lastResponded = model.messages.length;
      renderMessage('assistant', data.text, data.sources || [], data.tools_used || []);
      if (data.mode === 'openai-rag-mcp') {
        setStatus(`OpenAI ${data.model} · RAG + MCP`, 'ready');
      } else if (data.mode === 'openai-rag') {
        setStatus(`OpenAI ${data.model} · grounded RAG`, 'ready');
      } else {
        setStatus('Deterministic fallback response', 'ready');
      }
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
      const source = decision.provider === 'openai' ? 'OpenAI semantic EOT' : 'turn baseline';
      setStatus(`Listening for more… (${source}: WAIT)`, 'waiting');
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

  async function loadConfig() {
    try {
      model.config = await request('/api/assistant/config');
      setStatus(readyStatus(), 'ready');
    } catch (_) {
      model.config = null;
      setStatus('Assistant ready', 'ready');
    }
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

    let wasAuthenticated = false;
    const sync = () => {
      const authenticated = !appMain.hidden;
      setAuthenticated(authenticated);
      if (authenticated && !wasAuthenticated) loadConfig();
      wasAuthenticated = authenticated;
    };
    new MutationObserver(sync).observe(appMain, { attributes: true, attributeFilter: ['hidden'] });
    sync();
    renderMessage('assistant', 'Course-demo assistant ready. Send several short messages to test semantic turn-taking, ask a synthetic finance-process question for RAG, or ask about an FR request ID to exercise MCP.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

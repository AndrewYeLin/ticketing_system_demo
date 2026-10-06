'use strict';

const OpenAI = require('openai');

const DEFAULT_TURN_MODEL = 'gpt-6-luna';
const DEFAULT_CHAT_MODEL = 'gpt-6.1-sol';

function cleanMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message && message.role === 'assistant' ? 'assistant' : 'user',
      text: String(message && (message.text || message.content) || '').trim(),
    }))
    .filter((message) => message.text)
    .slice(-12);
}

function parseTurnDecision(text) {
  const value = String(text || '').trim().toUpperCase();
  if (value === 'WAIT' || /\bWAIT\b/.test(value)) return 'WAIT';
  if (value === 'RESPOND' || /\bRESPOND\b/.test(value)) return 'RESPOND';
  return '';
}

function mcpToolConfig(env) {
  const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '');
  const token = String(env.MCP_SERVER_TOKEN || '');
  if (!base || !token) return null;
  return {
    type: 'mcp',
    server_label: 'finance_demo',
    server_description: 'Read-only MCP tools for the synthetic COMP6708 Finance Request Tracker.',
    server_url: `${base}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    allowed_tools: [
      'search_finance_knowledge',
      'list_demo_requests',
      'get_demo_request',
      'get_demo_request_history',
    ],
    require_approval: 'never',
  };
}

function createOpenAIAdapter(options = {}) {
  const env = options.env || process.env;
  let client = options.client || null;

  function configured() {
    return String(env.LLM_PROVIDER || '').toLowerCase() === 'openai'
      && !!String(env.OPENAI_API_KEY || '').trim();
  }

  function getClient() {
    if (!configured()) return null;
    if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return client;
  }

  async function classifyTurn(input, heuristic) {
    if (!configured()) return { ...heuristic, provider: 'heuristic' };

    // Preserve hard safety/UX rules locally. This avoids paying for a model call when
    // the user has explicitly asked for a response or the max-wait guard has fired.
    if (heuristic && ['user-forced', 'max-wait-reached', 'no-user-message'].includes(heuristic.reason)) {
      return { ...heuristic, provider: 'heuristic-guardrail' };
    }

    const messages = cleanMessages(input && input.messages);
    const last = [...messages].reverse().find((message) => message.role === 'user');
    const elapsedMs = Math.max(0, Number(input && (input.elapsed_ms ?? input.elapsedMs) || 0));
    const idleMs = Math.max(250, Number(input && (input.idle_ms ?? input.idleMs) || heuristic && heuristic.idle_ms || 1200));

    // For ordinary fragments, first let the local burst timer expire. A direct question
    // ending in ? is allowed to ask the semantic classifier immediately.
    if (elapsedMs < idleMs && last && !/[?]\s*$/.test(last.text)) {
      return {
        ...(heuristic || {}),
        decision: 'WAIT',
        reason: 'message-burst-window',
        provider: 'heuristic-burst-gate',
      };
    }

    const transcript = messages
      .map((message, index) => `${index + 1}. ${message.role.toUpperCase()}: ${message.text}`)
      .join('\n');

    try {
      const response = await getClient().responses.create({
        model: String(env.OPENAI_TURN_MODEL || DEFAULT_TURN_MODEL),
        store: false,
        max_output_tokens: 8,
        instructions: [
          'You are an end-of-turn classifier for a task-oriented text chatbot.',
          'Decide whether the assistant should WAIT for more user messages or RESPOND now.',
          'Treat consecutive short user messages as one possible message burst.',
          'Prefer WAIT for fragments, corrections that appear unfinished, list-building, or content that strongly implies another message is coming.',
          'Prefer RESPOND for a complete direct question, an explicit turn-yield, or a semantically complete request where a useful next action is possible.',
          'Do not answer the user. Output exactly one token: WAIT or RESPOND.',
        ].join(' '),
        input: `Conversation burst:\n${transcript}\n\nMilliseconds since the latest user message: ${elapsedMs}.`,
      });

      const decision = parseTurnDecision(response.output_text);
      if (!decision) throw new Error('Model did not return WAIT or RESPOND.');
      return {
        ...(heuristic || {}),
        decision,
        reason: 'openai-semantic-eot',
        confidence: null,
        provider: 'openai',
        model: String(env.OPENAI_TURN_MODEL || DEFAULT_TURN_MODEL),
      };
    } catch (err) {
      console.warn('OpenAI turn classifier unavailable; using heuristic fallback:', err && err.message || 'unknown error');
      return {
        ...(heuristic || {}),
        provider: 'heuristic-fallback',
        fallback_reason: 'openai-unavailable',
      };
    }
  }

  async function generateGroundedAnswer({ messages, evidence = [] }) {
    if (!configured()) return null;

    const conversation = cleanMessages(messages)
      .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
      .join('\n');
    const evidenceText = evidence.length
      ? evidence.map((item, index) => [
        `[${index + 1}] ${item.title} — ${item.section}`,
        item.text,
      ].join('\n')).join('\n\n')
      : '(No relevant policy passage was retrieved.)';

    const tools = [];
    const mcp = mcpToolConfig(env);
    if (mcp) tools.push(mcp);

    const request = {
      model: String(env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL),
      store: false,
      max_output_tokens: 700,
      instructions: [
        'You are the COMP6708 Finance Request Tracker course-demo assistant.',
        'All finance guidance is synthetic academic-demo content, not official PolyU policy.',
        'For policy/process answers, use only the retrieved evidence supplied in the input. Do not invent missing policy facts.',
        'For live synthetic tracker data, use the read-only finance_demo MCP tools when useful.',
        'If the evidence or tools do not support an answer, say that the demo knowledge is insufficient.',
        'Never claim a request is approved, paid, eligible, or guaranteed unless the live synthetic tracker explicitly supports that statement.',
        'Keep responses concise, helpful, and clearly distinguish synthetic policy guidance from live synthetic tracker data.',
      ].join(' '),
      input: [
        'Conversation burst:',
        conversation || '(empty)',
        '',
        'Retrieved synthetic RAG evidence:',
        evidenceText,
      ].join('\n'),
    };
    if (tools.length) request.tools = tools;

    const response = await getClient().responses.create(request);
    const text = String(response.output_text || '').trim();
    if (!text) throw new Error('OpenAI returned no assistant text.');

    const toolsUsed = (Array.isArray(response.output) ? response.output : [])
      .filter((item) => item && item.type === 'mcp_call')
      .map((item) => item.name || 'mcp_tool')
      .filter(Boolean);

    return {
      mode: toolsUsed.length ? 'openai-rag-mcp' : 'openai-rag',
      model: String(env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL),
      text,
      tools_used: toolsUsed,
    };
  }

  return { configured, classifyTurn, generateGroundedAnswer };
}

const defaultAdapter = createOpenAIAdapter();

module.exports = {
  DEFAULT_TURN_MODEL,
  DEFAULT_CHAT_MODEL,
  cleanMessages,
  parseTurnDecision,
  mcpToolConfig,
  createOpenAIAdapter,
  configured: () => defaultAdapter.configured(),
  classifyTurn: (...args) => defaultAdapter.classifyTurn(...args),
  generateGroundedAnswer: (...args) => defaultAdapter.generateGroundedAnswer(...args),
};

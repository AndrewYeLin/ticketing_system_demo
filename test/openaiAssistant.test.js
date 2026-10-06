'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTurnDecision,
  mcpToolConfig,
  createOpenAIAdapter,
} = require('../lib/openaiAssistant');

test('turn decision parser accepts only WAIT or RESPOND semantics', () => {
  assert.equal(parseTurnDecision('WAIT'), 'WAIT');
  assert.equal(parseTurnDecision('respond'), 'RESPOND');
  assert.equal(parseTurnDecision('I think WAIT is best.'), 'WAIT');
  assert.equal(parseTurnDecision('maybe'), '');
});

test('MCP tool config is created only when URL and token exist', () => {
  assert.equal(mcpToolConfig({ APP_BASE_URL: '', MCP_SERVER_TOKEN: 'x' }), null);
  const config = mcpToolConfig({
    APP_BASE_URL: 'https://demo.example/',
    MCP_SERVER_TOKEN: 'secret',
  });
  assert.equal(config.type, 'mcp');
  assert.equal(config.server_url, 'https://demo.example/mcp');
  assert.equal(config.headers.Authorization, 'Bearer secret');
  assert.equal(config.require_approval, 'never');
});

test('semantic turn classification uses OpenAI response after burst gate', async () => {
  const calls = [];
  const client = {
    responses: {
      create: async (request) => {
        calls.push(request);
        return { output_text: 'WAIT', output: [] };
      },
    },
  };
  const adapter = createOpenAIAdapter({
    client,
    env: {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      OPENAI_TURN_MODEL: 'test-turn-model',
    },
  });
  const result = await adapter.classifyTurn(
    { messages: [{ role: 'user', text: 'Uber from the airport' }], elapsed_ms: 1500 },
    { decision: 'RESPOND', reason: 'idle-and-semantically-complete', idle_ms: 1200, max_wait_ms: 3600 },
  );
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'test-turn-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoning.effort, 'none');
  assert.equal(calls[0].max_output_tokens, 32);
});

test('burst gate avoids an OpenAI call for a fresh ordinary fragment', async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({
    client: { responses: { create: async () => { calls += 1; return { output_text: 'RESPOND' }; } } },
    env: { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
  });
  const result = await adapter.classifyTurn(
    { messages: [{ role: 'user', text: 'I need a reimbursement' }], elapsed_ms: 100 },
    { decision: 'WAIT', reason: 'message-burst-window', idle_ms: 1200, max_wait_ms: 3600 },
  );
  assert.equal(result.decision, 'WAIT');
  assert.equal(calls, 0);
});

test('grounded answer sends RAG evidence and remote MCP config', async () => {
  let request;
  const adapter = createOpenAIAdapter({
    client: {
      responses: {
        create: async (value) => {
          request = value;
          return {
            output_text: 'Synthetic answer.',
            output: [{ type: 'mcp_call', name: 'get_demo_request' }],
          };
        },
      },
    },
    env: {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      OPENAI_CHAT_MODEL: 'test-chat-model',
      APP_BASE_URL: 'https://demo.example',
      MCP_SERVER_TOKEN: 'mcp-secret',
    },
  });
  const result = await adapter.generateGroundedAnswer({
    messages: [{ role: 'user', text: 'What is the status of FR-20261005-001?' }],
    evidence: [{ title: 'Status Guide', section: 'Status questions', text: 'Use the live tracker.' }],
  });
  assert.equal(result.mode, 'openai-rag-mcp');
  assert.deepEqual(result.tools_used, ['get_demo_request']);
  assert.equal(request.model, 'test-chat-model');
  assert.equal(request.tools[0].type, 'mcp');
  assert.match(request.input, /Status Guide/);
});

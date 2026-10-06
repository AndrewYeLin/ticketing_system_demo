'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTurnDecision,
  mcpToolConfig,
  createOpenAIAdapter,
} = require('../lib/openaiAssistant');
const { verifyActorHeaders } = require('../lib/mcpActorAuth');

test('turn decision parser accepts only WAIT or RESPOND semantics', () => {
  assert.equal(parseTurnDecision('WAIT'), 'WAIT');
  assert.equal(parseTurnDecision('respond'), 'RESPOND');
  assert.equal(parseTurnDecision('I think WAIT is best.'), 'WAIT');
  assert.equal(parseTurnDecision('maybe'), '');
});

test('MCP tool config is role-aware and signs actor context', () => {
  assert.equal(mcpToolConfig({ APP_BASE_URL: '', MCP_SERVER_TOKEN: 'x' }), null);
  const env = {
    APP_BASE_URL: 'https://demo.example/',
    MCP_SERVER_TOKEN: 'secret',
  };

  const anonymous = mcpToolConfig(env);
  assert.deepEqual(anonymous.allowed_tools, ['search_finance_knowledge']);
  assert.equal(anonymous.headers.Authorization, 'Bearer secret');

  const requester = mcpToolConfig(env, {
    username: 'requester@polyu.edu.hk',
    role: 'requester',
    person_id: 'PER-002',
    display_name: 'Demo Requester',
  });
  assert.ok(requester.allowed_tools.includes('get_demo_request'));
  assert.equal(requester.allowed_tools.includes('get_request_summary'), false);
  assert.equal(verifyActorHeaders(requester.headers, 'secret').role, 'requester');

  const admin = mcpToolConfig(env, {
    username: 'admin@polyu.edu.hk',
    role: 'admin',
    person_id: 'PER-001',
    display_name: 'Demo Administrator',
  });
  assert.ok(admin.allowed_tools.includes('get_request_summary'));
  assert.ok(admin.allowed_tools.includes('get_request_bottlenecks'));
  assert.equal(verifyActorHeaders(admin.headers, 'secret').role, 'admin');
  assert.equal(admin.require_approval, 'never');
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
    { messages: [{ role: 'user', text: 'Uber from the airport' }], elapsed_ms: 3000 },
    { decision: 'RESPOND', reason: 'idle-and-semantically-complete', idle_ms: 2500, max_wait_ms: 3600 },
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
    { decision: 'WAIT', reason: 'message-burst-window', idle_ms: 2500, max_wait_ms: 3600 },
  );
  assert.equal(result.decision, 'WAIT');
  assert.equal(calls, 0);
});

test('grounded admin answer sends RAG evidence and role-aware MCP config', async () => {
  let request;
  const adapter = createOpenAIAdapter({
    client: {
      responses: {
        create: async (value) => {
          request = value;
          return {
            output_text: 'There are 3 open requests.',
            output: [{ type: 'mcp_call', name: 'get_request_summary' }],
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
    messages: [{ role: 'user', text: 'How many requests are open?' }],
    evidence: [{ title: 'Status Guide', section: 'Status questions', text: 'Use the live tracker.' }],
    actor: {
      username: 'admin@polyu.edu.hk',
      role: 'admin',
      person_id: 'PER-001',
      display_name: 'Demo Administrator',
    },
  });
  assert.equal(result.mode, 'openai-rag-mcp');
  assert.deepEqual(result.tools_used, ['get_request_summary']);
  assert.equal(request.model, 'test-chat-model');
  assert.equal(request.tools[0].type, 'mcp');
  assert.ok(request.tools[0].allowed_tools.includes('get_request_summary'));
  assert.equal(verifyActorHeaders(request.tools[0].headers, 'mcp-secret').role, 'admin');
  assert.match(request.input, /Status Guide/);
  assert.match(request.instructions, /Finance Admin/);
});

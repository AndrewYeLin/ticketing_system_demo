'use strict';

const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('../lib/store');
const { searchFinanceKnowledge } = require('../lib/knowledgeBase');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function safeRequest(row) {
  if (!row || String(row.deleted || '') === 'Yes') return null;
  return {
    request_id: row.request_id || '',
    request_type: row.request_type || '',
    sub_type: row.sub_type || '',
    current_status: row.current_status || '',
    waiting_on: row.waiting_on || '',
    next_action: row.next_action || '',
    short_description: row.short_description || '',
    amount: row.amount || '',
    currency: row.currency || '',
    activity_code: row.activity_code || '',
    submitted_at: row.submitted_at || '',
    completed_at: row.completed_at || '',
    last_updated_at: row.last_updated_at || '',
  };
}

function safeHistory(event) {
  if (!event || event.event_type === 'Internal Note') return null;
  return {
    changed_at: event.changed_at || event.timestamp || '',
    event_type: event.event_type || event.event || '',
    from_status: event.from_status || '',
    to_status: event.to_status || event.status || '',
    changed_by: event.changed_by || event.changed_by_username || '',
  };
}

function asText(value) {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function buildServer() {
  const server = new McpServer({ name: 'comp6708-finance-demo-http', version: '0.3.0' });

  server.registerTool(
    'search_finance_knowledge',
    {
      description: 'Search synthetic COMP6708 finance-demo knowledge. Not official PolyU policy.',
      inputSchema: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(5).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => asText({
      disclaimer: 'Synthetic academic demo content; not official PolyU policy.',
      results: searchFinanceKnowledge(query, { limit: limit || 3 }),
    }),
  );

  server.registerTool(
    'list_demo_requests',
    {
      description: 'List safe summary fields for synthetic requests in the course-demo tracker.',
      inputSchema: {
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const rows = (await store.readCurrent())
        .map(safeRequest)
        .filter(Boolean)
        .slice(0, limit || 20);
      return asText(rows);
    },
  );

  server.registerTool(
    'get_demo_request',
    {
      description: 'Read safe summary fields for one synthetic finance request by FR request ID.',
      inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
      annotations: { readOnlyHint: true },
    },
    async ({ request_id }) => {
      const row = safeRequest(await store.getRequestById(String(request_id).toUpperCase()));
      return asText(row || { error: 'Request not found' });
    },
  );

  server.registerTool(
    'get_demo_request_history',
    {
      description: 'Read non-private workflow history for one synthetic finance request.',
      inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
      annotations: { readOnlyHint: true },
    },
    async ({ request_id }) => {
      const history = (await store.getRequestHistory(String(request_id).toUpperCase()))
        .map(safeHistory)
        .filter(Boolean);
      return asText(history);
    },
  );

  return server;
}

function createDemoMcpHttpServer(options = {}) {
  const token = String(options.token || process.env.MCP_SERVER_TOKEN || '');

  async function handle(req, res, parsedBody) {
    const header = String(req.headers.authorization || '');
    const supplied = header.replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(supplied, token)) {
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: 'Unauthorized MCP request' }));
      return;
    }

    // Stateless MCP: each POST gets its own protocol server and transport. Reusing one
    // stateless transport across initialize + initialized + tool calls causes protocol
    // lifecycle errors, so follow the SDK's stateless server pattern exactly.
    if (req.method !== 'POST') {
      res.writeHead(405, {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'POST',
      });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    const cleanup = () => {
      try { transport.close(); } catch (_) { /* ignore */ }
      try { server.close(); } catch (_) { /* ignore */ }
    };
    res.once('close', cleanup);

    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  return { handle };
}

module.exports = {
  createDemoMcpHttpServer,
  buildServer,
  safeRequest,
  safeHistory,
  safeEqual,
};

'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('../lib/store');
const { searchFinanceKnowledge } = require('../lib/knowledgeBase');
const { TERMINAL_STATUSES } = require('../lib/constants');
const { safeEqual, verifyActorHeaders } = require('../lib/mcpActorAuth');

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
    changed_at: event.changed_at || event.timestamp || event.event_time || '',
    event_type: event.event_type || event.event || '',
    from_status: event.from_status || event.old_status || '',
    to_status: event.to_status || event.new_status || event.status || '',
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

function activeRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && String(row.deleted || '') !== 'Yes');
}

function isOpenRequest(row) {
  const status = String(row && row.current_status || '');
  return !!status && status !== 'Draft' && !TERMINAL_STATUSES.includes(status);
}

function countBy(rows, field) {
  const result = {};
  for (const row of rows) {
    const key = String(row && row[field] || '').trim() || 'Unspecified';
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function summarizeRequests(rows) {
  const visible = activeRows(rows);
  const drafts = visible.filter((row) => String(row.current_status || '') === 'Draft');
  const open = visible.filter(isOpenRequest);
  const terminal = visible.filter((row) => TERMINAL_STATUSES.includes(String(row.current_status || '')));
  return {
    definition: 'Open requests exclude Draft and terminal statuses (Closed, Completed, Cancelled, Approved, Rejected).',
    total_requests: visible.length,
    open_requests: open.length,
    drafts: drafts.length,
    terminal_requests: terminal.length,
    by_status: countBy(visible, 'current_status'),
    by_type: countBy(visible, 'request_type'),
    waiting_on_open_requests: countBy(open, 'waiting_on'),
  };
}

function timestampFor(row) {
  for (const value of [row.last_updated_at, row.submitted_at, row.created_at, row.received_date]) {
    const ms = Date.parse(String(value || ''));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function summarizeBottlenecks(rows, options = {}) {
  const staleDays = Math.max(1, Math.min(90, Number(options.staleDays || 7)));
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const open = activeRows(rows).filter(isOpenRequest);
  const threshold = now - staleDays * 24 * 60 * 60 * 1000;
  const stale = open
    .map((row) => ({ row, timestamp: timestampFor(row) }))
    .filter((item) => item.timestamp != null && item.timestamp < threshold)
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    stale_after_days: staleDays,
    open_requests: open.length,
    returned_for_info: open.filter((row) => String(row.current_status || '') === 'Returned for Info').length,
    waiting_on_user: open.filter((row) => String(row.waiting_on || '').toLowerCase() === 'user').length,
    stale_open_requests: stale.length,
    oldest_stale_requests: stale.slice(0, 10).map((item) => ({
      ...safeRequest(item.row),
      days_since_last_activity: Math.floor((now - item.timestamp) / (24 * 60 * 60 * 1000)),
    })),
  };
}

async function rowsForActor(actor) {
  if (!actor) return [];
  if (actor.role === 'admin') return activeRows(await store.readCurrent());
  return activeRows(await store.readOwnedRequests(actor.username, actor.person_id, actor.display_name));
}

async function canAccessRequest(actor, row) {
  if (!actor || !row || String(row.deleted || '') === 'Yes') return false;
  if (actor.role === 'admin') return true;
  return store.isRequestOwner(row, actor.username, actor.person_id, actor.display_name);
}

function buildServer(actor = null) {
  const server = new McpServer({ name: 'comp6708-finance-demo-http', version: '0.4.0' });

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

  if (actor) {
    server.registerTool(
      'list_demo_requests',
      {
        description: actor.role === 'admin'
          ? 'List safe summary fields for synthetic requests visible to Finance Admin.'
          : 'List safe summary fields for the signed-in requester\'s own synthetic requests.',
        inputSchema: {
          limit: z.number().int().min(1).max(30).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ limit }) => {
        const rows = (await rowsForActor(actor)).map(safeRequest).filter(Boolean).slice(0, limit || 20);
        return asText({ scope: actor.role === 'admin' ? 'admin-visible' : 'requester-owned', results: rows });
      },
    );

    server.registerTool(
      'get_demo_request',
      {
        description: 'Read safe summary fields for one accessible synthetic finance request by FR request ID.',
        inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
        annotations: { readOnlyHint: true },
      },
      async ({ request_id }) => {
        const row = await store.getRequestById(String(request_id).toUpperCase());
        if (!(await canAccessRequest(actor, row))) return asText({ error: 'Request not found or not accessible' });
        return asText(safeRequest(row));
      },
    );

    server.registerTool(
      'get_demo_request_history',
      {
        description: 'Read non-private workflow history for one accessible synthetic finance request.',
        inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
        annotations: { readOnlyHint: true },
      },
      async ({ request_id }) => {
        const id = String(request_id).toUpperCase();
        const row = await store.getRequestById(id);
        if (!(await canAccessRequest(actor, row))) return asText({ error: 'Request not found or not accessible' });
        const history = (await store.getRequestHistory(id)).map(safeHistory).filter(Boolean);
        return asText(history);
      },
    );
  }

  if (actor && actor.role === 'admin') {
    server.registerTool(
      'get_request_summary',
      {
        description: 'Return authoritative aggregate counts for the current synthetic Finance Admin request queue. Prefer this tool for questions such as how many requests are open.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => asText(summarizeRequests(await rowsForActor(actor))),
    );

    server.registerTool(
      'get_requests_by_status',
      {
        description: 'List safe request summaries matching one status. Use status "open" to return all non-Draft, non-terminal requests.',
        inputSchema: {
          status: z.string().min(1),
          limit: z.number().int().min(1).max(30).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ status, limit }) => {
        const wanted = String(status || '').trim().toLowerCase();
        const rows = await rowsForActor(actor);
        const matching = (wanted === 'open'
          ? rows.filter(isOpenRequest)
          : rows.filter((row) => String(row.current_status || '').trim().toLowerCase() === wanted))
          .slice(0, limit || 20)
          .map(safeRequest)
          .filter(Boolean);
        return asText({ status: wanted, results: matching });
      },
    );

    server.registerTool(
      'get_request_bottlenecks',
      {
        description: 'Return basic operational bottleneck indicators for the synthetic Finance Admin queue: returned-for-info, waiting-on-user and stale open requests.',
        inputSchema: {
          stale_days: z.number().int().min(1).max(90).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ stale_days }) => asText(summarizeBottlenecks(await rowsForActor(actor), { staleDays: stale_days || 7 })),
    );
  }

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

    const actor = verifyActorHeaders(req.headers, token);
    const server = buildServer(actor);
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
  isOpenRequest,
  summarizeRequests,
  summarizeBottlenecks,
};

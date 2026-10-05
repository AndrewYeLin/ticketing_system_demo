import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import knowledgeModule from '../lib/knowledgeBase.js';

const { searchFinanceKnowledge } = knowledgeModule;
const appBase = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const demoEmail = String(process.env.MCP_DEMO_EMAIL || '').trim();
const demoPassword = String(process.env.MCP_DEMO_PASSWORD || '');
let cookie = '';

async function ensureLogin() {
  if (cookie) return cookie;
  if (!appBase || !demoEmail || !demoPassword) {
    throw new Error('Ticket tools require APP_BASE_URL, MCP_DEMO_EMAIL and MCP_DEMO_PASSWORD.');
  }
  const res = await fetch(`${appBase}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: demoEmail, password: demoPassword }),
  });
  if (!res.ok) throw new Error(`Demo login failed (${res.status}).`);
  const setCookie = res.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('Demo login did not return a session cookie.');
  return cookie;
}

async function appGet(path) {
  const session = await ensureLogin();
  let res = await fetch(`${appBase}${path}`, { headers: { Cookie: session } });
  if (res.status === 401) {
    cookie = '';
    const retrySession = await ensureLogin();
    res = await fetch(`${appBase}${path}`, { headers: { Cookie: retrySession } });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Tracker request failed (${res.status}).`);
  return data;
}

function asText(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: 'comp6708-finance-demo', version: '0.2.0' });

server.registerTool(
  'search_finance_knowledge',
  {
    description: 'Search the synthetic COMP6708 finance-demo knowledge base. Results are not official PolyU policy.',
    inputSchema: {
      query: z.string().min(2),
      limit: z.number().int().min(1).max(5).optional(),
    },
  },
  async ({ query, limit }) => asText({
    disclaimer: 'Synthetic academic demo content; not official PolyU policy.',
    results: searchFinanceKnowledge(query, { limit: limit || 3 }),
  }),
);

server.registerTool(
  'list_requests',
  {
    description: 'Read requests visible to the configured demo account. Requires demo credentials in environment variables.',
    inputSchema: {},
  },
  async () => asText(await appGet('/api/requests')),
);

server.registerTool(
  'get_request',
  {
    description: 'Read one demo finance request by request ID using the configured demo account.',
    inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
  },
  async ({ request_id }) => asText(await appGet(`/api/requests/${encodeURIComponent(request_id)}`)),
);

server.registerTool(
  'get_request_history',
  {
    description: 'Read the audit history of one demo finance request using the configured demo account.',
    inputSchema: { request_id: z.string().regex(/^FR-\d{8}-\d{3}$/i) },
  },
  async ({ request_id }) => asText(await appGet(`/api/requests/${encodeURIComponent(request_id)}/history`)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

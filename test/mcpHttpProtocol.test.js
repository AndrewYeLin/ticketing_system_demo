'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createDemoMcpHttpServer } = require('../mcp/httpServer');
const { createActorHeaders } = require('../lib/mcpActorAuth');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function connectClient(baseUrl, token, actor, name) {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...createActorHeaders(token, actor),
      },
    },
  });
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}

test('role-aware Streamable HTTP MCP exposes admin insights only to admins', async () => {
  const token = 'unit-test-token-not-secret';
  const mcp = createDemoMcpHttpServer({ token });
  const httpServer = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      await mcp.handle(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('test server error');
    }
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const url = `http://127.0.0.1:${port}/mcp`;

  let admin;
  let requester;
  try {
    admin = await connectClient(url, token, {
      username: 'admin@polyu.edu.hk',
      role: 'admin',
      person_id: 'PER-001',
      display_name: 'Demo Administrator',
    }, 'comp6708-admin-http-test');
    const adminNames = (await admin.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(adminNames.includes('search_finance_knowledge'));
    assert.ok(adminNames.includes('get_demo_request'));
    assert.ok(adminNames.includes('get_request_summary'));
    assert.ok(adminNames.includes('get_requests_by_status'));
    assert.ok(adminNames.includes('get_request_bottlenecks'));

    const search = await admin.client.callTool({
      name: 'search_finance_knowledge',
      arguments: { query: 'reimbursement receipt', limit: 2 },
    });
    const searchText = search.content.find((item) => item.type === 'text').text;
    assert.match(searchText, /reimbursement|receipt/i);

    requester = await connectClient(url, token, {
      username: 'requester@polyu.edu.hk',
      role: 'requester',
      person_id: 'PER-002',
      display_name: 'Demo Requester',
    }, 'comp6708-requester-http-test');
    const requesterNames = (await requester.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(requesterNames.includes('get_demo_request'));
    assert.equal(requesterNames.includes('get_request_summary'), false);
    assert.equal(requesterNames.includes('get_request_bottlenecks'), false);
  } finally {
    if (admin) await admin.client.close().catch(() => {});
    if (requester) await requester.client.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

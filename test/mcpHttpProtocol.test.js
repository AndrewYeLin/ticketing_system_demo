'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createDemoMcpHttpServer } = require('../mcp/httpServer');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('bearer-protected Streamable HTTP MCP completes initialize, list and tool call', async () => {
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
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'comp6708-http-test', version: '0.1.0' });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('search_finance_knowledge'));
    assert.ok(names.includes('get_demo_request'));

    const result = await client.callTool({
      name: 'search_finance_knowledge',
      arguments: { query: 'reimbursement receipt', limit: 2 },
    });
    const text = result.content.find((item) => item.type === 'text').text;
    assert.match(text, /reimbursement|receipt/i);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

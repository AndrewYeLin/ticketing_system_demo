'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('MCP server exposes the synthetic knowledge tool and can call it', async () => {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'mcp', 'server.mjs')],
  });
  const client = new Client({ name: 'comp6708-test-client', version: '0.1.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('search_finance_knowledge'));
    assert.ok(names.includes('get_request'));
    const result = await client.callTool({
      name: 'search_finance_knowledge',
      arguments: { query: 'reimbursement receipt', limit: 2 },
    });
    assert.ok(result.content.some((item) => item.type === 'text' && /reimbursement|receipt/i.test(item.text)));
  } finally {
    await client.close();
  }
});

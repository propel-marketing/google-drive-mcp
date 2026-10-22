import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';
import { createAllMocks } from '../helpers/mock-google-apis.js';
import { createHttpApp, _setAuthClientForTesting } from '../../src/index.js';

const LIMIT = 32_768;
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const REFUSAL = {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'MCP HTTP input exceeds 32768 elements' },
  id: null,
};

function sheetBody(cells: number) {
  return {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'updateGoogleSheet', arguments: {
      spreadsheetId: 'synthetic-sheet', range: 'Sheet1!A1:Z1000',
      data: [Array(Math.floor(cells / 2)).fill(''), Array(Math.ceil(cells / 2)).fill('')],
      valueInputOption: 'RAW',
    } },
  };
}

async function withHttp(run: (f: {
  post: (body: unknown, session?: string) => Promise<{ status: number; body: any }>;
  session: string; transportCalls: () => number; providerCalls: () => number;
  sessions: Map<string, any>;
}) => Promise<void>) {
  const originalSheets = google.sheets;
  const mocks = createAllMocks();
  (google as any).sheets = mocks.google.sheets;
  _setAuthClientForTesting({});
  const { app, sessions } = createHttpApp('127.0.0.1');
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  async function post(body: unknown, session?: string) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    assert.ok(Buffer.byteLength(serialized) < 102400, 'exercise element guard, not byte limit');
    const res = await fetch(url, { method: 'POST', headers: {
      ...HEADERS, ...(session ? { 'mcp-session-id': session } : {}),
    }, body: serialized, signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const data = text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text;
    return { status: res.status, body: data ? JSON.parse(data) : null };
  }
  try {
    const init = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'element-test', version: '1' },
      },
    }) });
    assert.equal(init.status, 200);
    const session = init.headers.get('mcp-session-id')!;
    await init.text();
    assert.ok(session);
    let transportCalls = 0;
    const transport = sessions.get(session)!.transport;
    const handle = transport.handleRequest.bind(transport);
    transport.handleRequest = (...args: Parameters<typeof handle>) => { transportCalls++; return handle(...args); };
    await run({ post, session, transportCalls: () => transportCalls,
      providerCalls: () => mocks.sheets.tracker.getCalls('spreadsheets.values.update').length, sessions });
  } finally {
    for (const { transport, server } of sessions.values()) { await transport.close(); await server.close(); }
    sessions.clear();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    google.sheets = originalSheets;
    _setAuthClientForTesting(null);
  }
}

async function refused(f: Parameters<Parameters<typeof withHttp>[0]>[0], body: unknown, session?: string) {
  const result = await f.post(body, session);
  // Include structural counters in RED diagnostics; never include caller body.
  assert.equal(result.status, 413,
    `pre-dispatch guard required: transport=${f.transportCalls()} provider=${f.providerCalls()}`);
  assert.deepEqual(result.body, REFUSAL);
  assert.equal(f.transportCalls(), 0, 'must refuse before SDK transport/schema validation');
  assert.equal(f.providerCalls(), 0, 'must not execute provider tool');
}

describe('MCP HTTP total input element budget', () => {
  it('refuses a schema-valid over-cap Sheets grid before transport or provider dispatch', async () => {
    await withHttp(f => refused(f, sheetBody(LIMIT - 11), f.session));
  });
  it('accepts the exact 32768-element boundary and dispatches once', async () => {
    await withHttp(async f => {
      const result = await f.post(sheetBody(LIMIT - 12), f.session);
      assert.equal(result.status, 200);
      assert.equal(result.body.result.isError, false);
      assert.equal(f.transportCalls(), 1);
      assert.equal(f.providerCalls(), 1);
    });
  });
  it('preserves a legitimate 1000-row 26-column Sheet update', async () => {
    await withHttp(async f => {
      const body = sheetBody(0);
      body.params.arguments.data = Array.from({ length: 1000 }, () => Array(26).fill(''));
      const result = await f.post(body, f.session);
      assert.equal(result.status, 200);
      assert.equal(result.body.result.isError, false);
      assert.equal(f.providerCalls(), 1);
    });
  });
  it('counts unknown metadata, not only tool arguments', async () => {
    await withHttp(f => refused(f, { ...sheetBody(1), padding: Array(LIMIT).fill(0) }, f.session));
  });
  it('aggregates the entire batch before SDK dispatch', async () => {
    await withHttp(f => refused(f, [
      { ...sheetBody(1), padding: Array(17000).fill(0) },
      { ...sheetBody(1), padding: Array(17000).fill(0) },
    ], f.session));
  });
  it('refuses excessive nesting iteratively without dispatch', async () => {
    await withHttp(f => refused(f,
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"updateGoogleSheet","arguments":{},"extra":'
        + '['.repeat(LIMIT) + '0' + ']'.repeat(LIMIT) + '}}', f.session));
  });
  it('refuses oversized initialization before creating another session', async () => {
    await withHttp(async f => {
      await refused(f, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
        padding: Array(LIMIT).fill(0),
      } });
      assert.equal(f.sessions.size, 1);
    });
  });
  it('does not reflect caller IDs or unknown method names on refusal', async () => {
    await withHttp(f => refused(f, { jsonrpc: '2.0', id: 'caller-controlled-id',
      method: 'caller-controlled-method', params: { padding: Array(LIMIT).fill(0) } }, f.session));
  });
});

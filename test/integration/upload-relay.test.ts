import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp, _setAuthClientForTesting } from '../../src/index.js';
import { UploadRelay, RelayError, type RelayProvider } from '../../src/upload-relay.js';
import { createDriveRelayProvider } from '../../src/upload-drive.js';
import { _setUploadRelayForTesting } from '../../src/tools/upload.js';
import * as drive from '../../src/tools/drive.js';
import * as docs from '../../src/tools/docs.js';
import * as sheets from '../../src/tools/sheets.js';
import * as slides from '../../src/tools/slides.js';
import * as calendar from '../../src/tools/calendar.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const additions = ['uploadBegin', 'uploadChunk', 'uploadStatus', 'uploadCommit', 'uploadAbort'];
const declaration = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  filename: 'synthetic.bin', parent_folder_id: 'synthetic-folder', total_size_bytes: bytes.length,
  sha256: sha(bytes), mime_type: 'application/octet-stream', ...extra,
});
function elements(value: unknown): number {
  let count = 0;
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    count++;
    if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  return count;
}

/** All provider data is synthetic; only the MCP transport uses real loopback sockets. */
async function withRelay(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await f.close(); }
}
async function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-upload-http-'));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(join(root, 'ORIGIN'), 'Owned synthetic upload-relay integration fixture; removed on teardown.\n', { mode: 0o600 });
  const spoolDir = join(root, 'spool');
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  let allocations = 0;
  let writes = 0;
  const saved = new Map<string, Buffer>();
  const provider: RelayProvider = {
    async allocateId() { allocations++; return `synthetic-file-${allocations}`; },
    async commit(input) {
      if (input.parent_folder_id === 'invalid-folder') throw new RelayError('PARENT_INVALID');
      const bytes = fs.readFileSync(input.spoolPath);
      assert.equal(bytes.length, input.total_size_bytes);
      assert.equal(sha(bytes), input.sha256);
      assert.equal(createHash('md5').update(bytes).digest('hex'), input.md5);
      writes++;
      saved.set(input.fileId, bytes);
      return { file_id: input.fileId, parents: [input.parent_folder_id], size: bytes.length };
    },
  };
  const replace = async (replacement: RelayProvider = provider) => {
    await _setUploadRelayForTesting(new UploadRelay(replacement, { spoolDir }));
  };
  await replace();
  _setAuthClientForTesting({});
  const { app, sessions } = createHttpApp('127.0.0.1');
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const clients: Client[] = [];
  const secrets: string[] = [];
  async function connect() {
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'synthetic-upload-client', version: '1' });
    clients.push(client);
    await client.connect(transport);
    assert.ok(transport.sessionId);
    return { client, transport };
  }
  async function call(client: Client, name: string, args: Record<string, unknown>, error?: string) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError === true, error !== undefined);
    const content = response.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    const body = JSON.parse(content[0].text);
    if (error) assert.equal(body.code, error);
    if (name === 'uploadBegin' && !error) {
      assert.equal(typeof body.resume_secret, 'string');
      assert.ok(body.resume_secret.length >= 32);
      secrets.push(body.resume_secret);
    } else {
      assert.ok(!JSON.stringify(response).includes('resume_secret'));
      for (const secret of secrets) assert.ok(!JSON.stringify(response).includes(secret));
    }
    return body;
  }
  return { root, spoolDir, url, sessions, provider, saved, connect, call, replace,
    counts: () => ({ allocations, writes }),
    async close() {
      try {
        for (const client of clients) await client.close();
        for (const session of [...sessions.values()]) {
          await session.transport.close();
          await session.server.close();
        }
        sessions.clear();
        listener.closeAllConnections();
        await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve()));
        await _setUploadRelayForTesting();
        for (const secret of secrets) assert.ok(!logs.join('\n').includes(secret), 'logs must not disclose capability');
      } finally {
        console.error = originalError;
        _setAuthClientForTesting(null);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
const capability = (begin: { upload_id: string; resume_secret: string }) => ({
  upload_id: begin.upload_id, resume_secret: begin.resume_secret,
});

describe('durable upload relay over real SDK Streamable HTTP', { concurrency: false }, () => {
  it('lists exactly 105 tools and preserves the original 100 catalog entries byte-for-byte', async () => {
    await withRelay(async f => {
      const { client } = await f.connect();
      const baseline = [drive, docs, sheets, slides, calendar].flatMap(m => m.toolDefinitions);
      assert.equal(baseline.length, 100);
      const catalog = await client.listTools();
      assert.equal(catalog.tools.length, 105);
      assert.equal(new Set(catalog.tools.map(t => t.name)).size, 105);
      assert.equal(JSON.stringify(catalog.tools.filter(t => !additions.includes(t.name))), JSON.stringify(baseline));
      assert.deepEqual(catalog.tools.filter(t => additions.includes(t.name)).map(t => t.name), additions);
    });
  });

  it('accepts a 65536-byte / 87384-character chunk under the unchanged HTTP budgets and resumes after restart', async () => {
    await withRelay(async f => {
      const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
      const first = await f.connect();
      const begin = await f.call(first.client, 'uploadBegin', declaration(bytes, { consumer_label: 'consumer-A' }));
      assert.equal(begin.max_chunk_bytes, 65536);
      const args = { ...capability(begin), offset: 0, content_base64: bytes.toString('base64') };
      assert.equal(args.content_base64.length, 87384);
      const envelope = { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'uploadChunk', arguments: args } };
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 100 * 1024);
      assert.ok(elements(envelope) < 32768);
      const chunk = await f.call(first.client, 'uploadChunk', args);
      assert.equal(chunk.received_bytes, bytes.length);
      await first.client.close();
      await f.replace();
      const second = await f.connect();
      assert.notEqual(first.transport.sessionId, second.transport.sessionId);
      const status = await f.call(second.client, 'uploadStatus', { ...capability(begin), consumer_label: 'consumer-B' });
      assert.equal(status.next_expected_offset, bytes.length);
      const committed = await f.call(second.client, 'uploadCommit', capability(begin));
      assert.deepEqual(f.saved.get(committed.file_id), bytes);
      await f.replace();
      const third = await f.connect();
      assert.deepEqual(await f.call(third.client, 'uploadCommit', capability(begin)), committed);
      assert.equal((await f.call(third.client, 'uploadStatus', capability(begin))).state, 'committed');
      await f.call(third.client, 'uploadAbort', capability(begin));
      assert.deepEqual(f.counts(), { allocations: 1, writes: 1 });
    });
  });

  it('rejects missing and wrong secrets on all four capability methods before malformed chunk validation', async () => {
    await withRelay(async f => {
      const { client } = await f.connect();
      const begin = await f.call(client, 'uploadBegin', declaration(Buffer.from('synthetic-private-state')));
      for (const method of additions.slice(1)) {
        for (const secret of [undefined, 'synthetic-wrong-secret']) {
          const result = await f.call(client, method, {
            upload_id: begin.upload_id, ...(secret ? { resume_secret: secret } : {}),
            consumer_label: 'consumer-A', offset: -1, content_base64: { malformed: true },
          }, 'SESSION_NOT_FOUND');
          assert.deepEqual(result, { code: 'SESSION_NOT_FOUND' });
        }
      }
      assert.equal((await f.call(client, 'uploadStatus', capability(begin))).received_bytes, 0);
      await f.call(client, 'uploadAbort', capability(begin));
      assert.deepEqual(f.counts(), { allocations: 0, writes: 0 });
    });
  });

  it('rejects an overchunk with SIZE_EXCEEDED without changing progress or calling the provider', async () => {
    await withRelay(async f => {
      const { client } = await f.connect();
      const bytes = Buffer.alloc(65537, 7);
      const begin = await f.call(client, 'uploadBegin', declaration(bytes));
      await f.call(client, 'uploadChunk', { ...capability(begin), offset: 0, content_base64: bytes.toString('base64') }, 'SIZE_EXCEEDED');
      assert.equal((await f.call(client, 'uploadStatus', capability(begin))).received_bytes, 0);
      assert.deepEqual(f.counts(), { allocations: 0, writes: 0 });
      await f.call(client, 'uploadAbort', capability(begin));
    });
  });

  it('guards whole-request extra metadata with static 413 before SDK transport or provider dispatch', async () => {
    await withRelay(async f => {
      const { client, transport } = await f.connect();
      const begin = await f.call(client, 'uploadBegin', declaration(Buffer.from('x')));
      const serverTransport = f.sessions.get(transport.sessionId!)!.transport;
      const original = serverTransport.handleRequest.bind(serverTransport);
      let dispatches = 0;
      serverTransport.handleRequest = (...args: Parameters<typeof original>) => { dispatches++; return original(...args); };
      const body = { jsonrpc: '2.0', id: 'untrusted-id', method: 'tools/call',
        params: { name: 'uploadChunk', arguments: { ...capability(begin), offset: 0, content_base64: 'eA==' } },
        extra_metadata: Array(32768).fill(0) };
      assert.ok(elements(body) > 32768);
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 100 * 1024);
      const response = await fetch(f.url, { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'mcp-session-id': transport.sessionId!,
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { jsonrpc: '2.0', error: {
        code: -32600, message: 'MCP HTTP input exceeds 32768 elements',
      }, id: null });
      assert.equal(dispatches, 0);
      assert.deepEqual(f.counts(), { allocations: 0, writes: 0 });
      assert.equal((await f.call(client, 'uploadStatus', capability(begin))).received_bytes, 0);
    });
  });

  it('verifies hash before allocation/write and permits exact-range repair or abort', async () => {
    await withRelay(async f => {
      const { client } = await f.connect();
      const bytes = Buffer.from('synthetic-correct');
      for (const repair of [true, false]) {
        const begin = await f.call(client, 'uploadBegin', declaration(bytes));
        const before = f.counts();
        await f.call(client, 'uploadChunk', { ...capability(begin), offset: 0, content_base64: Buffer.alloc(bytes.length, 0).toString('base64') });
        await f.call(client, 'uploadCommit', capability(begin), 'HASH_MISMATCH');
        assert.deepEqual(f.counts(), before);
        if (repair) {
          await f.call(client, 'uploadChunk', { ...capability(begin), offset: 0, content_base64: bytes.toString('base64') });
          const result = await f.call(client, 'uploadCommit', capability(begin));
          assert.deepEqual(f.saved.get(result.file_id), bytes);
        } else assert.equal((await f.call(client, 'uploadAbort', capability(begin))).state, 'aborted');
      }
    });
  });

  it('returns exact public parent and static unexpected-exception errors without reflecting private data', async () => {
    await withRelay(async f => {
      const { client } = await f.connect();
      const bytes = Buffer.from('x');
      const begin = await f.call(client, 'uploadBegin', declaration(bytes, { parent_folder_id: 'invalid-folder' }));
      await f.call(client, 'uploadChunk', { ...capability(begin), offset: 0, content_base64: bytes.toString('base64') });
      assert.deepEqual(await f.call(client, 'uploadCommit', capability(begin), 'PARENT_INVALID'), { code: 'PARENT_INVALID' });
      const broken = new UploadRelay(f.provider, { spoolDir: join(f.root, 'broken') });
      broken.status = async () => { throw new Error(`synthetic-private-exception-${begin.resume_secret}`); };
      await _setUploadRelayForTesting(broken);
      assert.deepEqual(await f.call(client, 'uploadStatus', capability(begin), 'DRIVE_COMMIT_FAILED'), {
        code: 'DRIVE_COMMIT_FAILED', retryable: false,
      });
    });
  });

  it('streams synthetic binary and CSV bytes through the real Drive adapter with explicit folder and MIME preservation', async () => {
    await withRelay(async f => {
      let creates = 0;
      let putCount = 0;
      let allocated = 0;
      let metadata: any;
      const remote = new Map<string, any>();
      const expected = [Buffer.from([0, 255, 128, 13, 10, 0]), Buffer.from('name,value\r\n"synthetic, row",42\r\n')];
      const adapter = createDriveRelayProvider({
        getDrive: () => ({ files: {
          generateIds: async () => ({ data: { ids: [`synthetic-adapter-${++allocated}`] } }),
          get: async ({ fileId }: { fileId: string }) => {
            if (fileId === 'synthetic-folder') return { data: { id: fileId, mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } } };
            if (remote.has(fileId)) return { data: remote.get(fileId) };
            throw Object.assign(new Error('synthetic-not-found'), { code: 404 });
          },
        } }) as any,
        authClient: { request: async (request: any) => {
          assert.equal(request.retry, false);
          assert.equal(request.maxRedirects, 0);
          if (request.method === 'POST') {
            creates++;
            metadata = request.data;
            assert.deepEqual(metadata.parents, ['synthetic-folder']);
            assert.equal(metadata.mimeType, creates === 1 ? 'application/octet-stream' : 'text/csv');
            return { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic' } };
          }
          assert.equal(request.method, 'PUT');
          const chunks: Buffer[] = [];
          for await (const chunk of request.data) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          assert.deepEqual(bytes, expected[putCount++]);
          remote.set(metadata.id, { id: metadata.id, parents: metadata.parents, size: String(bytes.length), sha256Checksum: sha(bytes) });
          return { status: 200, data: {} };
        } } as any,
      });
      await f.replace(adapter);
      const { client } = await f.connect();
      for (let i = 0; i < expected.length; i++) {
        const bytes = expected[i];
        const begin = await f.call(client, 'uploadBegin', declaration(bytes, { filename: i ? 'synthetic.csv' : 'synthetic.bin', mime_type: i ? 'text/csv' : 'application/octet-stream' }));
        await f.call(client, 'uploadChunk', { ...capability(begin), offset: 0, content_base64: bytes.toString('base64') });
        const receipt = await f.call(client, 'uploadCommit', capability(begin));
        assert.deepEqual(receipt, { file_id: `synthetic-adapter-${i + 1}`, parents: ['synthetic-folder'], size: bytes.length });
        await f.call(client, 'uploadCommit', capability(begin));
      }
      assert.equal(creates, 2);
      assert.equal(putCount, 2);
    });
  });
});

for (const shutdown of ['EOF', 'SIGTERM'] as const) {
  it(`native CLI startup sweeps before first MCP call and ${shutdown} releases spool ownership`, { timeout: 60000 }, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'mcp-upload-cli-'));
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(join(root, 'ORIGIN'), 'Owned synthetic CLI lifecycle fixture.\n', { mode: 0o600 });
    const spoolDir = join(root, 'spool');
    // Expire a genuine persisted session, not an invented metadata format.
    const relay = new UploadRelay({ allocateId: async () => { throw new Error('must not allocate'); }, commit: async () => { throw new Error('must not write'); } }, { spoolDir, ttlMs: 100 });
    const begin = await relay.begin(declaration(Buffer.from('synthetic-expiring')));
    await relay.close();
    await delay(150);
    const env: NodeJS.ProcessEnv = { ...process.env, UPLOAD_RELAY_SPOOL_DIR: spoolDir };
    delete env.MCP_TESTING;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/index.js', import.meta.url)), 'start'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    try {
      const deadline = Date.now() + 45000;
      while (!fs.existsSync(join(spoolDir, '.owner')) || fs.existsSync(join(spoolDir, begin.upload_id, 'content'))
        || !stderr.includes('Server started successfully')) {
        assert.ok(Date.now() < deadline, 'CLI must acquire ownership and sweep without a tool call');
        assert.equal(child.exitCode, null);
        await delay(20);
      }
      assert.equal(JSON.parse(fs.readFileSync(join(spoolDir, '.owner'), 'utf8')).pid, child.pid);
      if (shutdown === 'EOF') child.stdin.end(); else child.kill('SIGTERM');
      const [code, signal] = await exit;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(fs.existsSync(join(spoolDir, '.owner')), false);
      assert.equal(stdout, '', 'no fabricated MCP responses before first request');
      assert.ok(!stderr.includes(begin.resume_secret));
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

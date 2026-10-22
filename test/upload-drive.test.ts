import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, ReadStream } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { GaxiosOptions, GaxiosResponse } from 'gaxios';
import { createDriveRelayProvider } from '../src/upload-drive.js';
import { RelayError, type RelayProvider } from '../src/upload-relay.js';

type Input = Parameters<RelayProvider['commit']>[0];
type Step = {
  method: string;
  path: string;
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
  inspect?: (options: GaxiosOptions) => void | Promise<void>;
  fault?: Error;
};
const FILE = 'reserved_file_123';
const PARENT = 'explicit_parent_456';
const UPLOAD = '/upload/drive/v3/files';
const SESSION = 'https://www.googleapis.com' + UPLOAD + '?uploadType=resumable&upload_id=synthetic_session';
const RESULT_FIELDS = 'id,parents,size,md5Checksum,sha256Checksum,trashed';

// Only the final Gaxios adapter is synthetic. OAuth dispatch, SDK query
// serialization, Gaxios JSON/stream preparation and HTTP classification are real.
function fixture(t: TestContext, steps: Step[], size = 11) {
  const root = mkdtempSync(join(tmpdir(), 'upload-drive-offline-'));
  writeFileSync(join(root, 'ORIGIN'), 'Synthetic upload-drive node:test fixture; removed on teardown.\n', { mode: 0o600 });
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 256;
  const spoolPath = join(root, 'content');
  writeFileSync(spoolPath, bytes, { mode: 0o600 });
  const input: Input = {
    fileId: FILE, parent_folder_id: PARENT, filename: 'binary-\u03c0.dat', mime_type: 'application/octet-stream',
    total_size_bytes: size, spoolPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    md5: createHash('md5').update(bytes).digest('hex'),
  };
  let networkAttempts = 0;
  const offline = () => { networkAttempts++; throw new Error('OFFLINE_TEST_NETWORK_DENIED'); };
  t.mock.method(net.Socket.prototype, 'connect', offline);
  t.mock.method(dns, 'lookup', offline);
  t.mock.method(dns, 'resolve', offline);
  t.mock.method(dns.promises, 'lookup', offline);
  t.mock.method(dns.promises, 'resolve', offline);
  t.mock.method(globalThis, 'fetch', offline);
  const auth = new OAuth2Client({ clientId: 'synthetic-client', clientSecret: 'synthetic-only' });
  // Generated test-only credentials never leave memory or enter diagnostics.
  auth.setCredentials({ access_token: randomBytes(32).toString('base64url'), refresh_token: randomBytes(32).toString('base64url'), expiry_date: Date.now() + 3600000 });
  const calls: { method: string; path: string }[] = [];
  const wireFailures: unknown[] = [];
  auth.transporter.defaults ??= {};
  auth.transporter.defaults.adapter = async options => {
    const url = new URL(String(options.url));
    const call = { method: String(options.method), path: url.pathname };
    calls.push(call);
    const step = steps.shift();
    try {
      assert.ok(step, 'unexpected synthetic wire dispatch');
      assert.deepEqual(call, { method: step.method, path: step.path });
      assert.equal(url.origin, 'https://www.googleapis.com');
      assert.equal(options.retry, false);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.follow, 0, 'Gaxios must disable underlying fetch redirects');
      const headers = options.headers as Record<string, string>;
      assert.ok(Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'authorization' && value.startsWith('Bearer ')), 'real OAuth must authenticate dispatch');
      await step.inspect?.(options);
    } catch (error) {
      wireFailures.push(error);
      throw new Error('SYNTHETIC_WIRE_ASSERTION_FAILED');
    }
    if (step!.fault) throw step!.fault;
    return { config: options, status: step!.status ?? 200, statusText: 'Synthetic', headers: step!.headers ?? {}, data: step!.data ?? {} } as GaxiosResponse;
  };
  const drive = google.drive({ version: 'v3', auth });
  const provider = createDriveRelayProvider({ getDrive: () => drive, authClient: auth });
  t.after(() => {
    // Remove owned files even if a negative assertion or wire expectation fails.
    rmSync(root, { recursive: true, force: true });
    assert.equal(networkAttempts, 0, 'no DNS/socket/fetch fallback attempts, even caught ones');
    if (wireFailures.length) throw wireFailures[0];
    assert.equal(steps.length, 0, 'all expected SDK wire operations must execute');
  });
  return { provider, input, calls, auth, bytes };
}
function parent(data: Record<string, unknown> = {}): Step {
  return { method: 'GET', path: '/drive/v3/files/' + PARENT,
    data: { id: PARENT, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true }, ...data },
    inspect(options) {
      const query = new URL(String(options.url)).searchParams;
      assert.equal(query.get('supportsAllDrives'), 'true');
      assert.equal(query.get('fields'), 'id,mimeType,trashed,capabilities(canAddChildren)');
    } };
}
function file(data: unknown = {}, status = 200): Step {
  return { method: 'GET', path: '/drive/v3/files/' + FILE, status, data,
    inspect(options) {
      const query = new URL(String(options.url)).searchParams;
      assert.equal(query.get('supportsAllDrives'), 'true');
      assert.equal(query.get('fields'), RESULT_FIELDS);
    } };
}
function metadata(input: Input): Record<string, unknown> {
  return { id: FILE, size: String(input.total_size_bytes), parents: [PARENT], md5Checksum: input.md5, sha256Checksum: input.sha256, trashed: false };
}
function post(overrides: Partial<Step> = {}): Step {
  return { method: 'POST', path: UPLOAD, headers: { location: SESSION }, ...overrides };
}
function put(overrides: Partial<Step> = {}): Step {
  return { method: 'PUT', path: UPLOAD, ...overrides };
}
async function failure(operation: Promise<unknown>, code = 'DRIVE_COMMIT_FAILED', retryable?: boolean) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    if (retryable !== undefined) assert.equal(error.retryable, retryable);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'next_expected_offset', 'retryable'].sort());
    return true;
  });
}

for (const size of [0, 5 * 1024 * 1024]) {
  test(`real SDK resumable JSON initiation and exact streamed ${size}-byte PUT, authoritative readback`, async t => {
    const steps: Step[] = [parent(), file({}, 404), post(), put(), file()];
    const f = fixture(t, steps, size);
    steps[2].inspect = options => {
      const url = new URL(String(options.url));
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(url.searchParams.get('fields'), 'id,parents,size,md5Checksum,sha256Checksum');
      assert.equal(url.searchParams.size, 3);
      assert.equal(typeof options.body, 'string');
      assert.deepEqual(JSON.parse(options.body as string), { id: FILE, name: f.input.filename, parents: [PARENT], mimeType: f.input.mime_type });
      assert.equal(options.multipart, undefined);
      const headers = options.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/json; charset=UTF-8');
      assert.equal(headers['X-Upload-Content-Length'], String(size));
      assert.equal(headers['X-Upload-Content-Type'], f.input.mime_type);
    };
    let stream: ReadStream | undefined;
    steps[3].inspect = async options => {
      assert.equal(String(options.url), SESSION);
      assert.ok(options.body instanceof ReadStream, 'must pass a file stream, not a buffered body');
      stream = options.body;
      assert.equal(stream.bytesRead, 0, 'spool must not be preconsumed before wire dispatch');
      assert.equal(options.multipart, undefined);
      const headers = options.headers as Record<string, string>;
      assert.equal(headers['Content-Length'], String(size));
      assert.equal(headers['Content-Type'], f.input.mime_type);
      assert.equal(headers['Content-Range'], size ? `bytes 0-${size - 1}/${size}` : 'bytes */0');
      let offset = 0;
      let chunks = 0;
      for await (const chunk of stream) {
        assert.ok(Buffer.isBuffer(chunk));
        assert.ok(chunk.length <= 64 * 1024, 'bounded filesystem reads');
        assert.ok(chunk.equals(f.bytes.subarray(offset, offset + chunk.length)), 'exact original binary bytes');
        offset += chunk.length;
        chunks++;
      }
      assert.equal(offset, size);
      if (size) assert.ok(chunks > 1);
    };
    steps[4].data = metadata(f.input);
    assert.deepEqual(await f.provider.commit(f.input), { file_id: FILE, parents: [PARENT], size });
    assert.ok(stream?.destroyed);
    assert.deepEqual(readFileSync(f.input.spoolPath), f.bytes, 'adapter must retain spool for engine ownership');
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST', 'PUT', 'GET']);
  });
}

test('allocateId uses real files.generateIds and validates exact single reserved ID', async t => {
  const f = fixture(t, [{ method: 'GET', path: '/drive/v3/files/generateIds', data: { ids: [FILE] }, inspect(options) {
    const query = new URL(String(options.url)).searchParams;
    assert.equal(query.get('count'), '1');
    assert.equal(query.get('space'), 'drive');
    assert.equal(query.get('type'), 'files');
  } }]);
  assert.equal(await f.provider.allocateId(), FILE);
});
for (const ids of [[], ['root'], ['unsafe/id'], [FILE, 'other'], [null]]) {
  test(`reject malformed generated ID response ${JSON.stringify(ids)}`, async t => {
    const f = fixture(t, [{ method: 'GET', path: '/drive/v3/files/generateIds', data: { ids } }]);
    await failure(f.provider.allocateId(), 'DRIVE_COMMIT_FAILED', false);
  });
}

for (const [label, data] of Object.entries({ nonfolder: { mimeType: 'text/plain' }, trashed: { trashed: true }, unwritable: { capabilities: { canAddChildren: false } }, wrongidentity: { id: 'other' } })) {
  test(`parent ${label} fails without upload initiation`, async t => {
    const f = fixture(t, [parent(data)]);
    await failure(f.provider.commit(f.input), 'PARENT_INVALID');
  });
}
for (const status of [403, 404]) {
  test(`parent HTTP ${status} is PARENT_INVALID, not an upload fallback`, async t => {
    const f = fixture(t, [{ ...parent(), status, data: { error: 'synthetic-private-provider-marker' } }]);
    await failure(f.provider.commit(f.input), 'PARENT_INVALID');
  });
}
for (const id of ['root', '', '../parent', 'parent?token=x', 'parent/child', 'parent\n']) {
  test(`unsafe explicit parent rejected locally (${JSON.stringify(id)})`, async t => {
    const f = fixture(t, []);
    await failure(f.provider.commit({ ...f.input, parent_folder_id: id }), 'PARENT_INVALID');
  });
}

test('stable existing ID reconciles repeatedly without POST or PUT; checksums optional', async t => {
  const steps = [parent(), file(), parent(), file()];
  const f = fixture(t, steps);
  steps[1].data = metadata(f.input);
  steps[3].data = { id: FILE, parents: [PARENT], size: String(f.input.total_size_bytes) };
  const first = await f.provider.commit(f.input);
  assert.deepEqual(await f.provider.commit(f.input), first);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'GET', 'GET']);
});
for (const [label, change] of Object.entries({ size: { size: '999' }, parent: { parents: ['wrong'] }, extraParent: { parents: [PARENT, 'extra'] }, md5: { md5Checksum: '0'.repeat(32) }, sha256: { sha256Checksum: '0'.repeat(64) }, identity: { id: 'wrong' }, trashed: { trashed: true }, malformedSize: { size: '011' } })) {
  for (const final of [false, true]) {
    test(`${final ? 'final authoritative readback' : 'existing reserved ID'} rejects ${label} mismatch`, async t => {
      const steps = final ? [parent(), file({}, 404), post(), put(), file()] : [parent(), file()];
      const f = fixture(t, steps);
      steps[steps.length - 1].data = { ...metadata(f.input), ...change };
      await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
      assert.deepEqual(readFileSync(f.input.spoolPath), f.bytes);
    });
  }
}
for (const [status, retryable] of [[403, false], [400, false], [408, true], [429, true], [503, true]] as const) {
  test(`reserved-ID HTTP ${status} is not absence; static retryable=${retryable}`, async t => {
    const f = fixture(t, [parent(), file({ error: 'synthetic-provider-input-reflection' }, status)]);
    // No refresh is needed for this metadata-read classification test.
    f.auth.forceRefreshOnFailure = false;
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', retryable);
  });
}

test('transient transport faults are sanitized and never mistaken for 404', async t => {
  const f = fixture(t, [parent(), { ...file(), fault: Object.assign(new Error('synthetic-secret-input'), { code: 'ECONNRESET' }) }]);
  await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', true);
});
for (const phase of ['POST', 'PUT'] as const) {
  test(`${phase} 409 reconciles same reserved ID without duplicate initiation`, async t => {
    const steps = phase === 'POST' ? [parent(), file({}, 404), post({ status: 409 }), file()] : [parent(), file({}, 404), post(), put({ status: 409 }), file()];
    const f = fixture(t, steps);
    steps[steps.length - 1].data = metadata(f.input);
    assert.equal((await f.provider.commit(f.input)).file_id, FILE);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  });
  test(`${phase} ambiguous 503 followed by retry reads same ID without another POST`, async t => {
    const steps = phase === 'POST' ? [parent(), file({}, 404), post({ status: 503 }), parent(), file()] : [parent(), file({}, 404), post(), put({ status: 503 }), parent(), file()];
    const f = fixture(t, steps);
    steps[steps.length - 1].data = metadata(f.input);
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', true);
    assert.equal((await f.provider.commit(f.input)).file_id, FILE);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  });
}

const unsafeLocations: unknown[] = [
  undefined, ['https://evil.invalid/'],
  'https://evil.invalid/upload/drive/v3/files?uploadType=resumable&upload_id=x',
  SESSION.replace('www.googleapis.com', 'www.googleapis.com.evil.invalid'),
  SESSION.replace('https:', 'http:'), SESSION.replace('www.', 'user:pass@www.'),
  SESSION + '#fragment', SESSION + '&redirect=https://evil.invalid/', SESSION + '&upload_id=duplicate',
  SESSION.replace('synthetic_session', '%2Fetc%2Fpasswd'), SESSION.replace('uploadType', '%75ploadType') + '&uploadType=resumable',
  SESSION.replace('/upload/drive', '/upload/%64rive'), SESSION.replace('www.googleapis.com', 'www.googleapis.com:444'),
  SESSION.replace('synthetic_session', 'bad%0D%0Aheader'), SESSION + '&supportsAllDrives=false',
  SESSION.replace('synthetic_session', ''), SESSION.replace('uploadType=resumable', 'uploadType=multipart'),
  SESSION + '&fields=unexpected', SESSION + '\n',
];
unsafeLocations.forEach((location, index) => {
  test(`unsafe session Location ${index} rejected before PUT`, async t => {
    const f = fixture(t, [parent(), file({}, 404), post({ headers: { location } })]);
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
  });
});
// Observed provider parameter shape/order only; every token below is synthetic.
const SESSION_CRD_SHAPE = 'https://www.googleapis.com' + UPLOAD
  + '?uploadType=resumable&supportsAllDrives=true&fields=id,parents,size,md5Checksum,sha256Checksum'
  + '&upload_id=synthetic_upload_id&session_crd=';
for (const [label, token] of [
  ['observed-shape', 'synthetic_session_crd_AZaz09_-'],
  ['minimum-length', 's'],
  ['maximum-length', 's'.repeat(8192)],
] as const) {
  test(`session_crd ${label}: real SDK POST, exact streamed PUT and authoritative GET`, async t => {
    const location = SESSION_CRD_SHAPE + token;
    const steps = [parent(), file({}, 404), post({ headers: { location } }), put(), file()];
    const f = fixture(t, steps);
    steps[2].inspect = options => {
      const url = new URL(String(options.url));
      assert.deepEqual([...url.searchParams], [
        ['uploadType', 'resumable'], ['supportsAllDrives', 'true'],
        ['fields', 'id,parents,size,md5Checksum,sha256Checksum'],
      ]);
      assert.equal(typeof options.body, 'string');
      assert.deepEqual(JSON.parse(options.body as string), {
        id: FILE, name: f.input.filename, parents: [PARENT], mimeType: f.input.mime_type,
      });
      const headers = options.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/json; charset=UTF-8');
      assert.equal(headers['X-Upload-Content-Length'], String(f.bytes.length));
      assert.equal(headers['X-Upload-Content-Type'], f.input.mime_type);
    };
    let stream: ReadStream | undefined;
    steps[3].inspect = async options => {
      assert.equal(String(options.url), location, 'preserve complete admitted Location without rewriting');
      assert.ok(options.body instanceof ReadStream);
      stream = options.body;
      assert.equal(stream.bytesRead, 0);
      assert.equal(options.multipart, undefined);
      const headers = options.headers as Record<string, string>;
      assert.equal(headers['Content-Length'], String(f.bytes.length));
      assert.equal(headers['Content-Type'], f.input.mime_type);
      assert.equal(headers['Content-Range'], `bytes 0-${f.bytes.length - 1}/${f.bytes.length}`);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        assert.ok(Buffer.isBuffer(chunk));
        assert.ok(chunk.length <= 64 * 1024);
        chunks.push(chunk);
      }
      assert.deepEqual(Buffer.concat(chunks), f.bytes);
    };
    steps[3].data = { id: 'synthetic_untrusted_put_response' };
    steps[4].data = metadata(f.input);
    assert.deepEqual(await f.provider.commit(f.input), { file_id: FILE, parents: [PARENT], size: f.bytes.length });
    assert.ok(stream?.destroyed);
    assert.deepEqual(readFileSync(f.input.spoolPath), f.bytes);
    assert.deepEqual(f.calls, [
      { method: 'GET', path: '/drive/v3/files/' + PARENT },
      { method: 'GET', path: '/drive/v3/files/' + FILE },
      { method: 'POST', path: UPLOAD }, { method: 'PUT', path: UPLOAD },
      { method: 'GET', path: '/drive/v3/files/' + FILE },
    ]);
  });
}
for (const [label, suffix] of [
  ['empty', ''], ['oversized', 's'.repeat(8193)],
  ['slash', 'synthetic/unsafe'], ['encoded-slash', 'synthetic%2Funsafe'],
  ['plus', 'synthetic+unsafe'], ['dot', 'synthetic.unsafe'],
  ['unicode', 'synthetic_\u03c0'], ['encoded-control', 'synthetic%0D%0Aunsafe'],
  ['duplicate', 'synthetic_first&session_crd=synthetic_second'],
  ['encoded-key-duplicate', 'synthetic_first&%73ession_crd=synthetic_second'],
  ['encoded-key-first-duplicate', 'synthetic_first&session_crd=synthetic_second'],
] as const) {
  test(`hostile session_crd ${label} rejected before PUT`, async t => {
    const prefix = label === 'encoded-key-first-duplicate'
      ? SESSION_CRD_SHAPE.replace('session_crd=', '%73ession_crd=') : SESSION_CRD_SHAPE;
    const f = fixture(t, [parent(), file({}, 404), post({ headers: { location: prefix + suffix } })]);
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  });
}
// Repeat every inherited Location refusal with the new optional parameter present.
unsafeLocations.forEach((location, index) => {
  test(`unsafe session Location ${index} remains rejected with session_crd before PUT`, async t => {
    const decorated = typeof location === 'string' ? location + '&session_crd=synthetic_guard_token'
      : Array.isArray(location) ? location.map(value => value + '&session_crd=synthetic_guard_token') : location;
    const f = fixture(t, [parent(), file({}, 404), post({ headers: { location: decorated } })]);
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  });
});
for (const [label, location] of [
  ['total-length', SESSION_CRD_SHAPE.replace('synthetic_upload_id', 's'.repeat(8192)) + 's'.repeat(8192)],
  ['backslash', SESSION_CRD_SHAPE + 'synthetic\\unsafe'],
  ['missing-upload-id', SESSION_CRD_SHAPE.replace('upload_id=synthetic_upload_id&', '') + 'synthetic_token'],
  ['oversized-upload-id', SESSION_CRD_SHAPE.replace('synthetic_upload_id', 's'.repeat(8193)) + 'synthetic_token'],
  ['duplicate-supportsAllDrives', SESSION_CRD_SHAPE + 'synthetic_token&supportsAllDrives=true'],
  ['duplicate-fields', SESSION_CRD_SHAPE + 'synthetic_token&fields=id,parents,size,md5Checksum,sha256Checksum'],
] as const) {
  test(`existing session guard ${label} remains rejected with session_crd before PUT`, async t => {
    const f = fixture(t, [parent(), file({}, 404), post({ headers: { location } })]);
    await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  });
}
test('duplicate differently-cased Location headers with session_crd rejected before PUT', async t => {
  const location = SESSION_CRD_SHAPE + 'synthetic_header_token';
  const f = fixture(t, [parent(), file({}, 404), post({ headers: { location, Location: location } })]);
  await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST']);
});
test('duplicate differently-cased Location headers rejected before PUT', async t => {
  const f = fixture(t, [parent(), file({}, 404), post({ headers: { location: SESSION, Location: SESSION } })]);
  await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', false);
});
for (const phase of ['POST', 'PUT'] as const) {
  for (const status of [401, 403, 302, 307, 308, 429, 503]) {
    test(`${phase} HTTP ${status}: no OAuth refresh/replay or redirect`, async t => {
      const rejected = { status, headers: { location: 'https://evil.invalid/redirect' }, data: { error: 'synthetic-private-marker' } };
      const steps = phase === 'POST' ? [parent(), file({}, 404), post(rejected)] : [parent(), file({}, 404), post(), put(rejected)];
      const f = fixture(t, steps);
      f.auth.forceRefreshOnFailure = true;
      assert.equal(f.auth.forceRefreshOnFailure, true);
      await failure(f.provider.commit(f.input), 'DRIVE_COMMIT_FAILED', status >= 500 || status === 429 || (phase === 'PUT' && status === 308));
      assert.equal(f.calls.filter(call => call.method === phase).length, 1);
      assert.ok(f.calls.every(call => call.path !== '/token'), 'no refresh request');
    });
  }
}
for (const mime of ['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.folder']) {
  test(`native Workspace MIME ${mime} fails nonretryably before any provider call`, async t => {
    const f = fixture(t, []);
    await failure(f.provider.commit({ ...f.input, mime_type: mime }), 'DRIVE_COMMIT_FAILED', false);
  });
}

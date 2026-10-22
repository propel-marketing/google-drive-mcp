import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, type TestContext } from 'node:test';
import { RelayError, UploadRelay, relayConfigFromEnv, type RelayConfig, type RelayProvider } from '../src/upload-relay.js';

type Capability = Awaited<ReturnType<UploadRelay['begin']>>;
type ProviderInput = Parameters<RelayProvider['commit']>[0];
type Receipt = Awaited<ReturnType<RelayProvider['commit']>>;
const testRoot = mkdtempSync(join(tmpdir(), 'upload-relay-engine-tests-'));
chmodSync(testRoot, 0o700);
writeFileSync(join(testRoot, 'ORIGIN.md'), 'Owned synthetic upload-relay engine test fixtures. Removed after this test file finishes. No production credentials or provider calls.\n', { mode: 0o600 });
after(() => rmSync(testRoot, { recursive: true, force: true }));

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class SyntheticProvider implements RelayProvider {
  allocations = 0;
  attempts: ProviderInput[] = [];
  files = new Map<string, Buffer>();
  creates = 0;
  failAllocation?: unknown;
  failCommit?: unknown;
  ambiguousOnce = false;
  receiptOverride?: (input: ProviderInput) => Receipt;

  async allocateId(): Promise<string> {
    this.allocations++;
    if (this.failAllocation) throw this.failAllocation;
    return `synthetic-file-${this.allocations}`;
  }

  async commit(input: ProviderInput): Promise<Receipt> {
    this.attempts.push(input);
    if (this.failCommit) throw this.failCommit;
    const bytes = readFileSync(input.spoolPath);
    assert.equal(bytes.length, input.total_size_bytes);
    assert.equal(sha256(bytes), input.sha256);
    assert.equal(createHash('md5').update(bytes).digest('hex'), input.md5);
    if (!this.files.has(input.fileId)) {
      this.files.set(input.fileId, bytes);
      this.creates++;
    } else {
      assert.ok(this.files.get(input.fileId)!.equals(bytes));
    }
    if (this.ambiguousOnce) {
      this.ambiguousOnce = false;
      throw new Error('synthetic ambiguous remote completion');
    }
    return this.receiptOverride?.(input) ?? { file_id: input.fileId, parents: [input.parent_folder_id], size: bytes.length };
  }
}

function fixture(t: TestContext, overrides: Partial<RelayConfig> = {}, provider = new SyntheticProvider()) {
  const spoolDir = join(testRoot, randomUUID());
  const config: RelayConfig = {
    spoolDir, maxSessionBytes: 8 * 1024 ** 2, maxGlobalBytes: 16 * 1024 ** 2,
    maxChunkBytes: 64 * 1024, ttlMs: 60_000, sweepIntervalMs: 60_000, maxSessions: 32, ...overrides,
  };
  const relays: UploadRelay[] = [];
  const open = () => {
    const relay = new UploadRelay(provider, config);
    relays.push(relay);
    return relay;
  };
  t.after(async () => {
    try {
      for (const relay of relays) await relay.close();
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });
  return { relay: open(), open, provider, config, spoolDir };
}

function declaration(bytes: Buffer, overrides: Partial<Parameters<UploadRelay['begin']>[0]> = {}) {
  return { filename: 'synthetic.bin', parent_folder_id: 'synthetic-parent', mime_type: 'application/octet-stream', total_size_bytes: bytes.length, sha256: sha256(bytes), ...overrides };
}

function contentPath(spoolDir: string, capability: Capability): string {
  return join(spoolDir, capability.upload_id, 'content');
}

function metadataPath(spoolDir: string, capability: Capability): string {
  return join(spoolDir, capability.upload_id, 'session.json');
}

async function upload(relay: UploadRelay, capability: Capability, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += capability.max_chunk_bytes) {
    await relay.chunk({ ...capability, offset, content_base64: bytes.subarray(offset, offset + capability.max_chunk_bytes).toString('base64') });
  }
}

async function rejectsCode(operation: () => Promise<unknown>, code: string, nextOffset?: number) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (nextOffset !== undefined) assert.equal(error.next_expected_offset, nextOffset);
    return true;
  });
}

async function waitUntil(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for actual asynchronous cleanup');
    await delay(10);
  }
}

test('5 MiB binary bytes survive chunking, hashing, commit, and idempotent receipt copies', async t => {
  const { relay, provider, spoolDir } = fixture(t);
  const bytes = Buffer.alloc(5 * 1024 ** 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const capability = await relay.begin(declaration(bytes));
  assert.equal(capability.max_chunk_bytes, 64 * 1024);
  await upload(relay, capability, bytes);
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(bytes));
  assert.equal((await relay.status(capability)).received_bytes, bytes.length);
  const receipt = await relay.commit(capability);
  assert.ok(provider.files.get(receipt.file_id)!.equals(bytes));
  assert.equal(receipt.size, bytes.length);
  assert.deepEqual(receipt.parents, ['synthetic-parent']);
  receipt.parents.push('caller-mutation');
  assert.deepEqual((await relay.commit(capability)).parents, ['synthetic-parent']);
  const status = await relay.status(capability);
  assert.equal(status.state, 'committed');
  status.parents!.push('caller-status-mutation');
  assert.deepEqual((await relay.status(capability)).parents, ['synthetic-parent']);
  assert.equal(provider.allocations, 1);
  assert.equal(provider.creates, 1);
  assert.equal(provider.attempts.length, 1);
  assert.equal(existsSync(contentPath(spoolDir, capability)), false);
});

test('2000-row CSV is retained byte-for-byte with Unicode, quoting, and CRLF', async t => {
  const { relay, provider } = fixture(t);
  const csv = 'id,label,value\r\n' + Array.from({ length: 2000 }, (_, index) => `${index},"café ${index}, ""quoted""",${index % 17}\r\n`).join('');
  const bytes = Buffer.from(csv);
  assert.equal(csv.split('\r\n').length - 2, 2000);
  const capability = await relay.begin(declaration(bytes, { filename: 'rows.csv', mime_type: 'text/csv' }));
  await upload(relay, capability, bytes);
  const receipt = await relay.commit(capability);
  assert.ok(provider.files.get(receipt.file_id)!.equals(bytes));
  assert.equal(provider.attempts[0].mime_type, 'text/csv');
});

test('capability has at least 256 bits, only its SHA-256 persists, and label is not authorization', async t => {
  const { relay, spoolDir } = fixture(t);
  const bytes = Buffer.from('capability');
  const capability = await relay.begin(declaration(bytes, { consumer_label: 'synthetic-consumer' }));
  assert.match(capability.upload_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(capability.resume_secret));
  assert.ok(Buffer.from(capability.resume_secret, 'base64url').length >= 32);
  const persisted = readFileSync(metadataPath(spoolDir, capability), 'utf8');
  assert.equal(persisted.includes(capability.resume_secret), false);
  const metadata = JSON.parse(persisted);
  assert.ok(metadata.secret_hash === sha256(capability.resume_secret));
  assert.equal('resume_secret' in metadata, false);
  assert.equal(metadata.consumer_label, 'synthetic-consumer');
  const status = await relay.status(capability);
  assert.equal('resume_secret' in status, false);
  assert.equal('secret_hash' in status, false);
  await rejectsCode(() => relay.status({ upload_id: capability.upload_id, resume_secret: 'synthetic-consumer' }), 'SESSION_NOT_FOUND');
});

test('all four capability operations hide missing, wrong, unknown, and invalid identifiers', async t => {
  const { relay, spoolDir, provider } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.from('abcd')));
  const metadataBefore = readFileSync(metadataPath(spoolDir, capability));
  const operations = [
    (auth: { upload_id: string; resume_secret?: string }) => relay.status(auth),
    (auth: { upload_id: string; resume_secret?: string }) => relay.chunk({ ...auth, offset: 0, content_base64: 'YQ==' }),
    (auth: { upload_id: string; resume_secret?: string }) => relay.commit(auth),
    (auth: { upload_id: string; resume_secret?: string }) => relay.abort(auth),
  ];
  for (const operation of operations) {
    for (const auth of [
      { upload_id: capability.upload_id },
      { upload_id: capability.upload_id, resume_secret: 'wrong' },
      { upload_id: randomUUID(), resume_secret: capability.resume_secret },
      { upload_id: '../escape', resume_secret: capability.resume_secret },
      { upload_id: capability.upload_id.toUpperCase(), resume_secret: capability.resume_secret },
    ]) await rejectsCode(() => operation(auth), 'SESSION_NOT_FOUND');
  }
  assert.ok(readFileSync(metadataPath(spoolDir, capability)).equals(metadataBefore));
  assert.equal(provider.allocations, 0);
  await relay.abort(capability);
  for (const operation of operations) await rejectsCode(() => operation({ upload_id: capability.upload_id }), 'SESSION_NOT_FOUND');
});

test('caller filename never controls spool paths and is passed literally to the provider', async t => {
  const { relay, spoolDir, provider } = fixture(t);
  const bytes = Buffer.from('safe');
  const filename = '../../outside/filename.bin';
  const capability = await relay.begin(declaration(bytes, { filename }));
  assert.deepEqual(readdirSync(spoolDir).sort(), ['.owner', capability.upload_id].sort());
  assert.deepEqual(readdirSync(join(spoolDir, capability.upload_id)).sort(), ['content', 'session.json']);
  await upload(relay, capability, bytes);
  await relay.commit(capability);
  assert.equal(provider.attempts[0].filename, filename);
  assert.equal(provider.attempts[0].spoolPath, contentPath(spoolDir, capability));
});

test('base64 accepts only canonical padded standard encoding', async t => {
  const { relay } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.alloc(16)));
  for (const content_base64 of ['', 'YQ', 'YQ=', 'YQ===', ' YQ==', 'YQ==\n', 'YR==', 'YWJ=', '-w==', '_w==', '====', 'Y=Q=']) {
    await rejectsCode(() => relay.chunk({ ...capability, offset: 0, content_base64 }), 'INVALID_BASE64');
  }
  for (const bytes of [Buffer.from([255]), Buffer.from([255, 254]), Buffer.from([255, 254, 253])]) {
    const fresh = await relay.begin(declaration(bytes));
    await relay.chunk({ ...fresh, offset: 0, content_base64: bytes.toString('base64') });
    await relay.commit(fresh);
  }
});

test('offsets are nonnegative safe integers with a truthful next_expected_offset field', async t => {
  const { relay } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.from('abcdef')));
  await relay.chunk({ ...capability, offset: 0, content_base64: Buffer.from('ab').toString('base64') });
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    await rejectsCode(() => relay.chunk({ ...capability, offset, content_base64: 'Yw==' }), 'OFFSET_MISMATCH', 2);
  }
  await rejectsCode(() => relay.chunk({ ...capability, offset: 1, content_base64: 'YmM=' }), 'OFFSET_MISMATCH', 2);
  await rejectsCode(() => relay.chunk({ ...capability, offset: 6, content_base64: 'Yw==' }), 'SIZE_EXCEEDED');
});

test('out-of-order gaps, same-range retry, and exact-range integrity repair are supported', async t => {
  const { relay, provider, spoolDir } = fixture(t);
  const bytes = Buffer.from('abcdefgh');
  const capability = await relay.begin(declaration(bytes));
  const tail = { ...capability, offset: 4, content_base64: bytes.subarray(4).toString('base64') };
  assert.equal((await relay.chunk(tail)).next_expected_offset, 0);
  await rejectsCode(() => relay.commit(capability), 'HASH_MISMATCH');
  await relay.chunk(tail);
  await relay.chunk({ ...capability, offset: 0, content_base64: Buffer.from('xxxx').toString('base64') });
  assert.equal((await relay.status(capability)).received_bytes, 8);
  await rejectsCode(() => relay.commit(capability), 'HASH_MISMATCH');
  assert.equal(provider.allocations, 0);
  assert.equal(provider.attempts.length, 0);
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(Buffer.from('xxxxefgh')));
  await relay.chunk({ ...capability, offset: 0, content_base64: bytes.subarray(0, 4).toString('base64') });
  await relay.commit(capability);
  assert.equal(provider.creates, 1);
});

for (const mutation of ['shorter', 'longer', 'same-size-corrupt'] as const) {
  test(`actual content ${mutation} is rejected before any provider allocation or commit`, async t => {
    const { relay, provider, spoolDir } = fixture(t);
    const bytes = Buffer.from('integrity');
    const capability = await relay.begin(declaration(bytes));
    await upload(relay, capability, bytes);
    const location = contentPath(spoolDir, capability);
    if (mutation === 'shorter') truncateSync(location, bytes.length - 1);
    if (mutation === 'longer') writeFileSync(location, Buffer.concat([bytes, Buffer.from('x')]));
    if (mutation === 'same-size-corrupt') writeFileSync(location, Buffer.alloc(bytes.length, 120));
    const corrupted = readFileSync(location);
    await rejectsCode(() => relay.commit(capability), 'HASH_MISMATCH');
    assert.equal(provider.allocations, 0);
    assert.equal(provider.attempts.length, 0);
    assert.ok(readFileSync(location).equals(corrupted));
    await relay.abort(capability);
    assert.equal(existsSync(location), false);
    assert.equal((await relay.status(capability)).state, 'aborted');
  });
}

test('declared global reservations serialize concurrent begin and release after abort', async t => {
  const { relay } = fixture(t, { maxSessionBytes: 6, maxGlobalBytes: 10 });
  const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => relay.begin(declaration(Buffer.alloc(6)))));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  for (const attempt of attempts) if (attempt.status === 'rejected') assert.equal(attempt.reason.code, 'SIZE_EXCEEDED');
  const accepted = attempts.find(attempt => attempt.status === 'fulfilled')!;
  assert.ok(accepted.status === 'fulfilled');
  await rejectsCode(() => relay.begin(declaration(Buffer.alloc(7))), 'SIZE_EXCEEDED');
  await relay.abort(accepted.value);
  await relay.begin(declaration(Buffer.alloc(6)));
});

test('reservations survive restart, release after commit, and do not count chunk retries twice', async t => {
  const { relay, open } = fixture(t, { maxSessionBytes: 4, maxGlobalBytes: 4 });
  const bytes = Buffer.from('abcd');
  const capability = await relay.begin(declaration(bytes));
  await upload(relay, capability, bytes);
  await upload(relay, capability, bytes);
  await relay.close();
  const restarted = open();
  await rejectsCode(() => restarted.begin(declaration(Buffer.from('x'))), 'SIZE_EXCEEDED');
  await restarted.commit(capability);
  await restarted.begin(declaration(bytes));
});

test('decoded chunk limit accepts exact boundary and rejects oversized or declared overflow', async t => {
  const { relay } = fixture(t, { maxChunkBytes: 3 });
  const capability = await relay.begin(declaration(Buffer.from('abcdef')));
  await relay.chunk({ ...capability, offset: 0, content_base64: Buffer.from('abc').toString('base64') });
  await rejectsCode(() => relay.chunk({ ...capability, offset: 0, content_base64: Buffer.from('abcd').toString('base64') }), 'SIZE_EXCEEDED');
  await rejectsCode(() => relay.chunk({ ...capability, offset: 0, content_base64: 'A'.repeat(100) }), 'SIZE_EXCEEDED');
  await rejectsCode(() => relay.chunk({ ...capability, offset: 5, content_base64: 'YWI=' }), 'SIZE_EXCEEDED');
});

test('maxSessions includes terminal receipts and is enforced during restart admission', async t => {
  const { relay, open, provider, config } = fixture(t, { maxSessions: 2 });
  const first = await relay.begin(declaration(Buffer.alloc(0)));
  await relay.commit(first);
  await relay.begin(declaration(Buffer.alloc(0)));
  await rejectsCode(() => relay.begin(declaration(Buffer.alloc(0))), 'SIZE_EXCEEDED');
  await relay.close();
  const lowered = new UploadRelay(provider, { ...config, maxSessions: 1 });
  try {
    await rejectsCode(() => lowered.status(first), 'SIZE_EXCEEDED');
  } finally { await lowered.close(); }
  assert.equal((await open().status(first)).state, 'committed');
});

test('empty file commits with empty SHA-256 and MD5 without chunks', async t => {
  const { relay, provider } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.alloc(0)));
  assert.equal((await relay.status(capability)).received_bytes, 0);
  const receipt = await relay.commit(capability);
  assert.equal(receipt.size, 0);
  assert.equal(provider.attempts[0].sha256, sha256(Buffer.alloc(0)));
  assert.equal(provider.attempts[0].md5, 'd41d8cd98f00b204e9800998ecf8427e');
});

test('actual timer expires an abandoned open upload and releases reservations', async t => {
  const { relay, spoolDir } = fixture(t, { ttlMs: 1000, sweepIntervalMs: 10, maxSessionBytes: 4, maxGlobalBytes: 4 });
  const capability = await relay.begin(declaration(Buffer.from('abcd')));
  await upload(relay, capability, Buffer.from('abcd'));
  await waitUntil(() => !existsSync(contentPath(spoolDir, capability)));
  assert.equal((await relay.status(capability)).state, 'expired');
  await rejectsCode(() => relay.chunk({ ...capability, offset: 0, content_base64: 'YQ==' }), 'SESSION_EXPIRED');
  await rejectsCode(() => relay.commit(capability), 'SESSION_EXPIRED');
  await relay.begin(declaration(Buffer.from('abcd')));
});

for (const terminal of ['committed', 'aborted'] as const) {
  test(`${terminal} receipt remains available then actual sweeper removes it after terminal TTL`, async t => {
    const { relay, spoolDir } = fixture(t, { ttlMs: 1000, sweepIntervalMs: 10 });
    const capability = await relay.begin(declaration(Buffer.alloc(0)));
    if (terminal === 'committed') await relay.commit(capability);
    else await relay.abort(capability);
    assert.equal((await relay.status(capability)).state, terminal);
    await waitUntil(() => !existsSync(join(spoolDir, capability.upload_id)));
    await rejectsCode(() => relay.status(capability), 'SESSION_NOT_FOUND');
  });
}

test('close preserves partial bytes, restart resumes and committed receipt remains idempotent', async t => {
  const { relay, open, provider } = fixture(t);
  const bytes = Buffer.from('abcdefgh');
  const capability = await relay.begin(declaration(bytes));
  await relay.chunk({ ...capability, offset: 0, content_base64: bytes.subarray(0, 4).toString('base64') });
  await relay.close();
  await relay.close();
  await rejectsCode(() => relay.status(capability), 'RELAY_CLOSED');
  const restarted = open();
  assert.equal((await restarted.status(capability)).next_expected_offset, 4);
  await restarted.chunk({ ...capability, offset: 4, content_base64: bytes.subarray(4).toString('base64') });
  const receipt = await restarted.commit(capability);
  await restarted.close();
  const final = open();
  assert.equal((await final.status(capability)).file_id, receipt.file_id);
  assert.deepEqual(await final.commit(capability), receipt);
  assert.equal(provider.allocations, 1);
  assert.equal(provider.creates, 1);
  assert.equal(provider.attempts.length, 1);
});

test('ambiguous remote completion restarts with stable file ID and exactly one provider create', async t => {
  const { relay, open, provider, spoolDir } = fixture(t);
  provider.ambiguousOnce = true;
  const bytes = Buffer.from('ambiguous');
  const capability = await relay.begin(declaration(bytes));
  await upload(relay, capability, bytes);
  await rejectsCode(() => relay.commit(capability), 'DRIVE_COMMIT_FAILED');
  assert.equal((await relay.status(capability)).commit_pending, true);
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(bytes));
  await relay.close();
  const restarted = open();
  assert.equal((await restarted.status(capability)).commit_pending, true);
  const receipt = await restarted.commit(capability);
  assert.equal(provider.allocations, 1);
  assert.equal(provider.creates, 1);
  assert.equal(provider.attempts.length, 2);
  assert.equal(provider.attempts[0].fileId, provider.attempts[1].fileId);
  assert.equal(receipt.file_id, provider.attempts[0].fileId);
});

for (const terminal of ['abort', 'expiry'] as const) {
  test(`pending ambiguous commit ${terminal} cleans spool and prevents remote retries`, async t => {
    const { relay, provider, spoolDir } = fixture(t, { ttlMs: 1000, sweepIntervalMs: 10, maxSessionBytes: 4, maxGlobalBytes: 4 });
    provider.ambiguousOnce = true;
    const bytes = Buffer.from('abcd');
    const capability = await relay.begin(declaration(bytes));
    await upload(relay, capability, bytes);
    await rejectsCode(() => relay.commit(capability), 'DRIVE_COMMIT_FAILED');
    if (terminal === 'abort') assert.equal((await relay.abort(capability)).state, 'aborted');
    else await waitUntil(() => !existsSync(contentPath(spoolDir, capability)));
    assert.equal(existsSync(contentPath(spoolDir, capability)), false);
    assert.equal((await relay.status(capability)).state, terminal === 'abort' ? 'aborted' : 'expired');
    await rejectsCode(() => relay.commit(capability), terminal === 'abort' ? 'SESSION_CLOSED' : 'SESSION_EXPIRED');
    assert.equal(provider.creates, 1);
    assert.equal(provider.files.size, 1);
    assert.equal(provider.attempts.length, 1);
    await relay.begin(declaration(bytes));
  });

  test(`pending ${terminal} terminal receipt survives restart until bounded retention`, async t => {
    const { relay, provider, spoolDir, open } = fixture(t, { ttlMs: 1000, sweepIntervalMs: 10 });
    provider.ambiguousOnce = true;
    const capability = await relay.begin(declaration(Buffer.alloc(0)));
    await rejectsCode(() => relay.commit(capability), 'DRIVE_COMMIT_FAILED');
    if (terminal === 'abort') await relay.abort(capability);
    else await waitUntil(() => !existsSync(contentPath(spoolDir, capability)));
    await relay.close();
    const restarted = open();
    assert.equal((await restarted.status(capability)).state, terminal === 'abort' ? 'aborted' : 'expired');
    assert.equal(provider.creates, 1);
  });
}

test('allocation failure is sanitized and retry remains open without losing bytes', async t => {
  const { relay, provider, spoolDir } = fixture(t);
  provider.failAllocation = new Error('synthetic provider private detail');
  const bytes = Buffer.from('retry');
  const capability = await relay.begin(declaration(bytes));
  await upload(relay, capability, bytes);
  await rejectsCode(() => relay.commit(capability), 'DRIVE_COMMIT_FAILED');
  assert.equal(provider.attempts.length, 0);
  assert.equal((await relay.status(capability)).commit_pending, undefined);
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(bytes));
  provider.failAllocation = undefined;
  await relay.commit(capability);
});

test('typed invalid parent and generic provider failure preserve spool and stable pending identity', async t => {
  const { relay, provider, spoolDir } = fixture(t);
  const bytes = Buffer.from('parent');
  const capability = await relay.begin(declaration(bytes));
  await upload(relay, capability, bytes);
  provider.failCommit = new RelayError('PARENT_INVALID');
  await rejectsCode(() => relay.commit(capability), 'PARENT_INVALID');
  provider.failCommit = new Error('synthetic upstream detail');
  await assert.rejects(() => relay.commit(capability), (error: unknown) => error instanceof RelayError && error.code === 'DRIVE_COMMIT_FAILED' && error.retryable === true && error.message === 'DRIVE_COMMIT_FAILED');
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(bytes));
  provider.failCommit = undefined;
  await relay.commit(capability);
  assert.equal(provider.allocations, 1);
  assert.equal(new Set(provider.attempts.map(attempt => attempt.fileId)).size, 1);
});

for (const malformed of ['id', 'parent', 'multiple-parents', 'size'] as const) {
  test(`malformed provider ${malformed} receipt is rejected with content retained for retry`, async t => {
    const { relay, provider, spoolDir } = fixture(t);
    const bytes = Buffer.from('receipt');
    const capability = await relay.begin(declaration(bytes));
    await upload(relay, capability, bytes);
    provider.receiptOverride = input => ({
      file_id: malformed === 'id' ? 'wrong-id' : input.fileId,
      parents: malformed === 'parent' ? ['wrong-parent'] : malformed === 'multiple-parents' ? [input.parent_folder_id, 'extra'] : [input.parent_folder_id],
      size: malformed === 'size' ? bytes.length + 1 : bytes.length,
    });
    await rejectsCode(() => relay.commit(capability), 'DRIVE_COMMIT_FAILED');
    assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(bytes));
    assert.equal((await relay.status(capability)).commit_pending, true);
    provider.receiptOverride = undefined;
    await relay.commit(capability);
    assert.equal(provider.allocations, 1);
    assert.equal(provider.creates, 1);
  });
}

test('corrupt and truncated persisted open ranges are discarded and repairable after restart', async t => {
  const { relay, open, spoolDir } = fixture(t);
  const bytes = Buffer.from('abcdefghijkl');
  const capability = await relay.begin(declaration(bytes));
  for (let offset = 0; offset < bytes.length; offset += 4) await relay.chunk({ ...capability, offset, content_base64: bytes.subarray(offset, offset + 4).toString('base64') });
  await relay.close();
  writeFileSync(contentPath(spoolDir, capability), Buffer.from('abcdxxxxij'));
  const restarted = open();
  assert.equal((await restarted.status(capability)).next_expected_offset, 4);
  const metadata = JSON.parse(readFileSync(metadataPath(spoolDir, capability), 'utf8'));
  assert.equal(metadata.ranges.length, 1);
  await restarted.chunk({ ...capability, offset: 8, content_base64: bytes.subarray(8).toString('base64') });
  assert.equal((await restarted.status(capability)).next_expected_offset, 4);
  await restarted.chunk({ ...capability, offset: 4, content_base64: bytes.subarray(4, 8).toString('base64') });
  await restarted.commit(capability);
});

test('malformed persisted range metadata is refused rather than trusted', async t => {
  const { relay, open, spoolDir } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.from('abcd')));
  await relay.close();
  const location = metadataPath(spoolDir, capability);
  const metadata = JSON.parse(readFileSync(location, 'utf8'));
  metadata.ranges = [{ start: -1, end: 4, sha256: sha256('abcd') }];
  writeFileSync(location, JSON.stringify(metadata));
  await rejectsCode(() => open().status(capability), 'RELAY_STORAGE_UNSAFE');
});

test('same-process second owner is refused and private filesystem modes are enforced', async t => {
  const { relay, open, spoolDir } = fixture(t);
  const capability = await relay.begin(declaration(Buffer.from('x')));
  for (const location of [spoolDir, join(spoolDir, capability.upload_id)]) assert.equal(lstatSync(location).mode & 0o777, 0o700);
  for (const location of [join(spoolDir, '.owner'), contentPath(spoolDir, capability), metadataPath(spoolDir, capability)]) assert.equal(lstatSync(location).mode & 0o777, 0o600);
  await rejectsCode(() => open().status(capability), 'RELAY_SPOOL_LOCKED');
  assert.equal((await relay.status(capability)).state, 'open');
});

for (const unsafe of ['root-mode', 'content-mode', 'root-symlink', 'content-symlink'] as const) {
  test(`unsafe ${unsafe} is refused without consuming an outside file`, async t => {
    const { relay, open, spoolDir } = fixture(t);
    const bytes = Buffer.from('private');
    const capability = await relay.begin(declaration(bytes));
    await relay.close();
    const outside = join(testRoot, randomUUID());
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    if (unsafe === 'root-mode') chmodSync(spoolDir, 0o755);
    if (unsafe === 'content-mode') chmodSync(contentPath(spoolDir, capability), 0o644);
    if (unsafe === 'root-symlink') {
      rmSync(spoolDir, { recursive: true });
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, spoolDir);
    }
    if (unsafe === 'content-symlink') {
      writeFileSync(outside, bytes, { mode: 0o600 });
      rmSync(contentPath(spoolDir, capability));
      symlinkSync(outside, contentPath(spoolDir, capability));
    }
    await rejectsCode(() => open().status(capability), 'RELAY_STORAGE_UNSAFE');
    if (unsafe === 'content-symlink') assert.ok(readFileSync(outside).equals(bytes));
  });
}

test('real live child owner is refused; SIGKILL recovery resumes durable upload and receipt', async t => {
  const { relay, spoolDir, provider, config, open } = fixture(t);
  await relay.close();
  const moduleUrl = new URL('../src/upload-relay.js', import.meta.url).href;
  const script = `import { UploadRelay } from ${JSON.stringify(moduleUrl)};
    const relay = new UploadRelay({ allocateId: async () => 'child-file', commit: async () => { throw Error('unexpected'); } }, ${JSON.stringify(config)});
    const capability = await relay.begin(${JSON.stringify(declaration(Buffer.from('abcdefgh')))});
    await relay.chunk({ ...capability, offset: 0, content_base64: 'YWJjZA==' });
    process.send(capability);
    setInterval(() => {}, 1000);`;
  const child = fork(new URL('../src/upload-relay.js', import.meta.url), [], { execArgv: ['--input-type=module', '--eval', script], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const capability = await new Promise<Capability>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child capability timeout')), 5000);
    child.once('message', message => { clearTimeout(timer); resolve(message as Capability); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited before durable upload receipt')); });
  });
  const contender = new UploadRelay(provider, config);
  try { await rejectsCode(() => contender.status(capability), 'RELAY_SPOOL_LOCKED'); }
  finally { await contender.close(); }
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  const recovered = open();
  assert.equal((await recovered.status(capability)).next_expected_offset, 4);
  assert.ok(readFileSync(contentPath(spoolDir, capability)).equals(Buffer.from('abcd')));
  await recovered.chunk({ ...capability, offset: 4, content_base64: 'ZWZnaA==' });
  await recovered.commit(capability);
  assert.equal(provider.creates, 1);
});

test('invalid declarations reject before allocating session directories', async t => {
  const { relay, spoolDir } = fixture(t);
  for (const overrides of [
    { filename: '' }, { filename: 'bad\0name' }, { parent_folder_id: '' }, { mime_type: '' },
    { total_size_bytes: -1 }, { total_size_bytes: 0.5 }, { total_size_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'invalid' }, { sha256: 'A'.repeat(64) }, { consumer_label: '' },
  ]) await rejectsCode(() => relay.begin(declaration(Buffer.from('x'), overrides)), 'INVALID_ARGUMENT');
  assert.deepEqual(readdirSync(spoolDir), ['.owner']);
});

test('environment defaults, overrides, and invalid values are validated with complete restoration', () => {
  const names = ['XDG_CONFIG_HOME', 'UPLOAD_RELAY_SPOOL_DIR', 'UPLOAD_RELAY_MAX_SESSION_BYTES', 'UPLOAD_RELAY_MAX_GLOBAL_BYTES', 'UPLOAD_RELAY_MAX_CHUNK_BYTES', 'UPLOAD_RELAY_TTL_MS', 'UPLOAD_RELAY_SWEEP_INTERVAL_MS', 'UPLOAD_RELAY_MAX_SESSIONS'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.XDG_CONFIG_HOME = testRoot;
    assert.deepEqual(relayConfigFromEnv(), {
      spoolDir: join(testRoot, 'google-drive-mcp', 'upload-relay'), maxSessionBytes: 1024 ** 3,
      maxGlobalBytes: 4 * 1024 ** 3, maxChunkBytes: 64 * 1024, ttlMs: 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60 * 1000, maxSessions: 1024,
    });
    const numericNames = names.filter(name => name.startsWith('UPLOAD_RELAY_') && name !== 'UPLOAD_RELAY_SPOOL_DIR');
    for (const name of numericNames) {
      for (const invalid of ['', '0', '-1', '1.2', '1e3', ' 1', '9007199254740992']) {
        process.env[name] = invalid;
        assert.throws(() => relayConfigFromEnv(), (error: unknown) => error instanceof RelayError && error.code === 'RELAY_CONFIG_INVALID');
      }
      delete process.env[name];
    }
    for (const spool of ['relative', '']) {
      process.env.UPLOAD_RELAY_SPOOL_DIR = spool;
      assert.throws(() => relayConfigFromEnv(), RelayError);
    }
    process.env.UPLOAD_RELAY_SPOOL_DIR = join(testRoot, 'configured');
    process.env.UPLOAD_RELAY_MAX_SESSION_BYTES = '10';
    process.env.UPLOAD_RELAY_MAX_GLOBAL_BYTES = '20';
    process.env.UPLOAD_RELAY_MAX_CHUNK_BYTES = '3';
    process.env.UPLOAD_RELAY_TTL_MS = '100';
    process.env.UPLOAD_RELAY_SWEEP_INTERVAL_MS = '10';
    process.env.UPLOAD_RELAY_MAX_SESSIONS = '2';
    assert.deepEqual(relayConfigFromEnv(), { spoolDir: join(testRoot, 'configured'), maxSessionBytes: 10, maxGlobalBytes: 20, maxChunkBytes: 3, ttlMs: 100, sweepIntervalMs: 10, maxSessions: 2 });
    assert.throws(() => new UploadRelay(new SyntheticProvider(), { spoolDir: '/invalid\0path' }), RelayError);
    for (const [name, value] of [
      ['UPLOAD_RELAY_MAX_SESSION_BYTES', '21'], ['UPLOAD_RELAY_MAX_CHUNK_BYTES', '67108865'],
      ['UPLOAD_RELAY_SWEEP_INTERVAL_MS', '2147483648'], ['UPLOAD_RELAY_MAX_SESSIONS', '100001'],
      ['UPLOAD_RELAY_TTL_MS', '8640000000000000'],
    ]) {
      const accepted = process.env[name];
      process.env[name] = value;
      assert.throws(() => relayConfigFromEnv(), RelayError);
      process.env[name] = accepted;
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

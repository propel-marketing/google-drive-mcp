import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const Decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const ListInput = z.object({ folderId: Identifier, pageToken: z.string().min(1).max(4096).optional() }).strict();
const ReadInput = z.object({ fileId: Identifier, expectedVersion: Decimal, maxBytes: z.number().int().min(1).max(16777216) }).strict();
const OriginalMetadata = z.object({
  id: Identifier, name: z.string().min(1).max(4096), mimeType: z.string().min(1).max(256),
  size: Decimal.nullish(), trashed: z.boolean(), version: Decimal,
  parents: z.array(Identifier).max(100), md5Checksum: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});
const Fields = 'id,name,mimeType,size,trashed,version,parents,md5Checksum';
// Runaway guards, not performance targets. 16 MiB at 0.5 Mbit/s needs ~270 s;
// 600 s leaves a wide margin. Idle time is separate from total elapsed time.
// Nest outward: metadata 60 s / media idle 120 s < read 600 s < client 660 s;
// metadata 60 s < listing 120 s < client 150 s (client configured separately).
const READ_WALL_MS = 600000;
const LIST_WALL_MS = 120000;
const MEDIA_IDLE_MS = 120000;
const METADATA_MS = 60000;
let readingOriginal = false;

type Cause = 'input_invalid' | 'version_mismatch' | 'size_out_of_range' | 'native_document'
  | 'metadata_timeout' | 'media_idle_timeout' | 'wall_clock_guard' | 'short_read'
  | 'md5_mismatch' | 'changed_during_read' | 'reader_busy' | 'client_disconnected'
  | `upstream_error:${number | 'unknown'}`;
class Refusal extends Error {
  constructor(readonly causeName: Cause) { super(causeName); }
}
function causeOf(error: unknown): Cause {
  if (error instanceof Refusal) return error.causeName;
  if (error instanceof z.ZodError) return 'input_invalid';
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? `upstream_error:${status}` : 'upstream_error:unknown';
}
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
// Settle even if a provider ignores abort; late media is disposed separately.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) abort();
  });
}
async function metadataCall<T>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkAbort(parent);
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Refusal('metadata_timeout')), METADATA_MS);
  try {
    return await abortable(operation(controller.signal), controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') throw new Refusal('metadata_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}

export const originalReadDefinitions: ToolDefinition[] = [
  { name: 'listFolderStructured', description: 'Read one bounded page of original Drive metadata with explicit completeness and continuation. Does not export or modify files.',
    inputSchema: { type: 'object', properties: { folderId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' }, pageToken: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['folderId'], additionalProperties: false } },
  { name: 'readOriginalFile', description: 'Read bounded original regular-file bytes at an expected version. Returns SHA256 and base64, never exports native documents or writes local files.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' }, expectedVersion: { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$' }, maxBytes: { type: 'integer', minimum: 1, maximum: 16777216 } }, required: ['fileId', 'expectedVersion', 'maxBytes'], additionalProperties: false } },
];

function projectedMetadata(raw: unknown) {
  const metadata = OriginalMetadata.parse(raw);
  return { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size ?? null,
    trashed: metadata.trashed, shortcut: metadata.mimeType === 'application/vnd.google-apps.shortcut',
    version: metadata.version, parents: metadata.parents };
}

function response(structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}

function refused(read: boolean, cause: Cause): ToolResult {
  // Only fixed causes and numeric status codes. Never log errors or args.
  console.error(`[Drive.${read ? 'originalRead' : 'listStructured'}] refused cause=${cause}`);
  return { content: [{ type: 'text', text: JSON.stringify({ code: 'ORIGINAL_READ_REFUSED', error: '[Drive.originalRead] Input, metadata, media or deadline qualification failed.', nextAction: 'Refresh metadata and qualify the read contract; no automatic retry.' }) }], isError: true };
}

async function listStructured(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult> {
  const input = ListInput.parse(args);
  const page = await metadataCall(signal, requestSignal => ctx.getDrive().files.list({ q: `'${input.folderId}' in parents and trashed = false`,
    pageSize: 100, pageToken: input.pageToken, fields: `nextPageToken,incompleteSearch,files(${Fields})`,
    orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true }, { signal: requestSignal, timeout: METADATA_MS, retry: false }));
  const raw = z.object({ files: z.array(OriginalMetadata).max(100), incompleteSearch: z.boolean(),
    nextPageToken: z.string().min(1).max(4096).optional() }).parse(page.data);
  const files = raw.files.map(projectedMetadata);
  if (files.some(file => !file.parents.includes(input.folderId) || file.trashed)
      || new Set(files.map(file => file.id)).size !== files.length) throw new Refusal('input_invalid');
  checkAbort(signal);
  const nextPageToken = raw.nextPageToken ?? null;
  return response({ contractVersion: 1, folderId: input.folderId, files, nextPageToken,
    complete: nextPageToken === null && !raw.incompleteSearch, incompleteSearch: raw.incompleteSearch });
}

async function originalBytes(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult> {
  const input = ReadInput.parse(args);
  const drive = ctx.getDrive();
  const parameters = { fileId: input.fileId, fields: Fields, supportsAllDrives: true };
  const getMetadata = () => metadataCall(signal, requestSignal => drive.files.get(parameters,
    { signal: requestSignal, timeout: METADATA_MS, retry: false }));
  const before = OriginalMetadata.parse((await getMetadata()).data);
  if (before.id !== input.fileId || before.trashed) throw new Refusal('input_invalid');
  if (before.version !== input.expectedVersion) throw new Refusal('version_mismatch');
  if (before.mimeType.startsWith('application/vnd.google-apps.')) throw new Refusal('native_document');
  if (!before.size || BigInt(before.size) < 1n || BigInt(before.size) > BigInt(input.maxBytes)) throw new Refusal('size_out_of_range');
  const expectedSize = Number(before.size);
  const buffer = Buffer.alloc(expectedSize);
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let received = 0;
  let media: Readable | undefined;
  const mediaController = new AbortController();
  const abort = () => mediaController.abort(signal.reason);
  const destroy = () => media?.destroy(new Refusal(causeOf(mediaController.signal.reason)));
  signal.addEventListener('abort', abort, { once: true });
  mediaController.signal.addEventListener('abort', destroy, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => mediaController.abort(new Refusal('media_idle_timeout')), MEDIA_IDLE_MS);
  };
  try {
    checkAbort(signal);
    resetIdle(); // Includes headers/first byte; no media per-call timeout.
    // TODO(P1-CAUSE): apply the measured defect and add its regression test after
    // disposable-instance timings return. Guards alone are NOT a cause fix.
    const mediaRequest = drive.files.get({ fileId: input.fileId, alt: 'media', supportsAllDrives: true },
      { signal: mediaController.signal, retry: false, responseType: 'stream' }).then(result => {
        if (mediaController.signal.aborted) (result.data as Readable)?.destroy?.();
        return result;
      });
    media = (await abortable(mediaRequest, mediaController.signal)).data as Readable;
    checkAbort(mediaController.signal);
    if (!media || typeof media[Symbol.asyncIterator] !== 'function'
        || typeof media.destroy !== 'function') throw new Refusal('input_invalid');
    for await (const chunk of media) {
      checkAbort(mediaController.signal);
      if (!Buffer.isBuffer(chunk)) throw new Refusal('input_invalid');
      if (chunk.length > expectedSize - received) throw new Refusal('size_out_of_range');
      if (chunk.length > 0) resetIdle(); // Empty chunks are not progress.
      chunk.copy(buffer, received);
      received += chunk.length;
      sha256.update(chunk);
      md5.update(chunk);
    }
    checkAbort(mediaController.signal);
    clearTimeout(idleTimer); // Media idle does not cover reconciliation.
    if (received !== expectedSize) throw new Refusal('short_read');
    const after = OriginalMetadata.parse((await getMetadata()).data);
    if (JSON.stringify(projectedMetadata(before)) !== JSON.stringify(projectedMetadata(after))
        || before.md5Checksum !== after.md5Checksum) throw new Refusal('changed_during_read');
    checkAbort(signal);
    const observedMd5 = md5.digest('hex');
    if (before.md5Checksum && before.md5Checksum !== observedMd5) throw new Refusal('md5_mismatch');
    return response({ contractVersion: 1, fileId: before.id, version: before.version,
      mimeType: before.mimeType, size: before.size, sha256: sha256.digest('hex'), blob: buffer.toString('base64') });
  } catch (error) {
    throw mediaController.signal.aborted ? mediaController.signal.reason : error;
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener('abort', abort);
    mediaController.signal.removeEventListener('abort', destroy);
    media?.destroy();
    buffer.fill(0);
  }
}

// TODO(D2-WIRING): the dispatcher supplies only name/args/ctx, with no HTTP
// request/response. Wire this signal to premature response close before claiming
// disconnect handling is live. Normal request close after body receipt is not it.
export async function handleOriginalRead(name: string, args: unknown, ctx: ToolContext,
  clientDisconnected?: AbortSignal): Promise<ToolResult> {
  const read = name === 'readOriginalFile';
  if (!read && name !== 'listFolderStructured') return refused(read, 'input_invalid');
  if (read && readingOriginal) return refused(read, 'reader_busy');
  if (read) readingOriginal = true;
  const controller = new AbortController();
  const abort = () => controller.abort(new Refusal('client_disconnected'));
  const timer = setTimeout(() => controller.abort(new Refusal('wall_clock_guard')), read ? READ_WALL_MS : LIST_WALL_MS);
  try {
    clientDisconnected?.addEventListener('abort', abort, { once: true });
    if (clientDisconnected?.aborted) abort();
    checkAbort(controller.signal);
    return await (read ? originalBytes(args, ctx, controller.signal) : listStructured(args, ctx, controller.signal));
  } catch (error) {
    return refused(read, causeOf(controller.signal.aborted ? controller.signal.reason : error));
  } finally {
    clearTimeout(timer);
    clientDisconnected?.removeEventListener('abort', abort);
    if (read) readingOriginal = false;
  }
}

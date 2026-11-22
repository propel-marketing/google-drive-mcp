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
let readingOriginal = false;

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

function refused(): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ code: 'ORIGINAL_READ_REFUSED', error: '[Drive.originalRead] Input, metadata, media or deadline qualification failed.', nextAction: 'Refresh metadata and qualify the read contract; no automatic retry.' }) }], isError: true };
}

async function listStructured(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult> {
  const input = ListInput.parse(args);
  const page = await ctx.getDrive().files.list({ q: `'${input.folderId}' in parents and trashed = false`,
    pageSize: 100, pageToken: input.pageToken, fields: `nextPageToken,incompleteSearch,files(${Fields})`,
    orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true }, { signal, timeout: 15000, retry: false });
  const raw = z.object({ files: z.array(OriginalMetadata).max(100), incompleteSearch: z.boolean(),
    nextPageToken: z.string().min(1).max(4096).optional() }).parse(page.data);
  const files = raw.files.map(projectedMetadata);
  if (files.some(file => !file.parents.includes(input.folderId) || file.trashed)
      || new Set(files.map(file => file.id)).size !== files.length) throw new Error();
  const nextPageToken = raw.nextPageToken ?? null;
  return response({ contractVersion: 1, folderId: input.folderId, files, nextPageToken,
    complete: nextPageToken === null && !raw.incompleteSearch, incompleteSearch: raw.incompleteSearch });
}

async function originalBytes(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult> {
  const input = ReadInput.parse(args);
  const drive = ctx.getDrive();
  const parameters = { fileId: input.fileId, fields: Fields, supportsAllDrives: true };
  const options = { signal, timeout: 15000, retry: false };
  const before = OriginalMetadata.parse((await drive.files.get(parameters, options)).data);
  if (before.id !== input.fileId || before.version !== input.expectedVersion || before.trashed
      || before.mimeType.startsWith('application/vnd.google-apps.') || !before.size
      || BigInt(before.size) < 1n || BigInt(before.size) > BigInt(input.maxBytes)) throw new Error();
  const expectedSize = Number(before.size);
  const buffer = Buffer.alloc(expectedSize);
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let received = 0;
  let media: Readable | undefined;
  const destroy = () => media?.destroy(new Error('Original read deadline'));
  signal.addEventListener('abort', destroy, { once: true });
  try {
    media = (await drive.files.get({ fileId: input.fileId, alt: 'media', supportsAllDrives: true },
      { ...options, responseType: 'stream' })).data as Readable;
    if (signal.aborted || !media || typeof media[Symbol.asyncIterator] !== 'function'
        || typeof media.destroy !== 'function') throw new Error();
    for await (const chunk of media) {
      if (signal.aborted || !Buffer.isBuffer(chunk) || chunk.length > expectedSize - received) throw new Error();
      chunk.copy(buffer, received);
      received += chunk.length;
      sha256.update(chunk);
      md5.update(chunk);
    }
    if (signal.aborted || received !== expectedSize) throw new Error();
    const after = OriginalMetadata.parse((await drive.files.get(parameters, options)).data);
    if (JSON.stringify(projectedMetadata(before)) !== JSON.stringify(projectedMetadata(after))
        || before.md5Checksum !== after.md5Checksum || signal.aborted) throw new Error();
    const observedMd5 = md5.digest('hex');
    if (before.md5Checksum && before.md5Checksum !== observedMd5) throw new Error();
    return response({ contractVersion: 1, fileId: before.id, version: before.version,
      mimeType: before.mimeType, size: before.size, sha256: sha256.digest('hex'), blob: buffer.toString('base64') });
  } finally {
    signal.removeEventListener('abort', destroy);
    media?.destroy();
    buffer.fill(0);
  }
}

export async function handleOriginalRead(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const read = name === 'readOriginalFile';
  if ((!read && name !== 'listFolderStructured') || read && readingOriginal) return refused();
  if (read) readingOriginal = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await (read ? originalBytes(args, ctx, controller.signal) : listStructured(args, ctx, controller.signal));
  } catch {
    return refused();
  } finally {
    clearTimeout(timer);
    if (read) readingOriginal = false;
  }
}

import { createReadStream } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { ToolContext } from './types.js';
import { RelayError, type RelayProvider } from './upload-relay.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RESULT_FIELDS = 'id,parents,size,md5Checksum,sha256Checksum,trashed';
const UPLOAD_FIELDS = 'id,parents,size,md5Checksum,sha256Checksum';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
  + '?uploadType=resumable&supportsAllDrives=true&fields=' + UPLOAD_FIELDS;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const MIME = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

type CommitInput = Parameters<RelayProvider['commit']>[0];
type CommitResult = Awaited<ReturnType<RelayProvider['commit']>>;

function fail(retryable = false): RelayError {
  return new RelayError('DRIVE_COMMIT_FAILED', { retryable });
}

// Never retain provider exceptions as an exported cause, message or context.
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { response?: { status?: unknown }; code?: unknown };
  const status = value.response?.status ?? value.code;
  if (typeof status === 'number' && Number.isInteger(status)) return status;
  if (typeof status === 'string' && /^[1-5][0-9]{2}$/.test(status)) return Number(status);
  return undefined;
}

function canRetry(error: unknown): boolean {
  const status = statusOf(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && value !== 'root';
}

function validateInput(input: CommitInput): void {
  if (!input || typeof input !== 'object') throw fail();
  if (!validId(input.parent_folder_id)) throw new RelayError('PARENT_INVALID');
  if (!validId(input.fileId) || input.fileId === input.parent_folder_id
    || typeof input.filename !== 'string' || input.filename.length === 0
    || /[\u0000-\u001f\u007f]/.test(input.filename)
    || typeof input.mime_type !== 'string' || !MIME.test(input.mime_type)
    // Native Workspace conversion cannot preserve binary size/checksums.
    || input.mime_type.toLowerCase().startsWith('application/vnd.google-apps.')
    || !Number.isSafeInteger(input.total_size_bytes) || input.total_size_bytes < 0
    || typeof input.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sha256)
    || typeof input.md5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(input.md5)
    || typeof input.spoolPath !== 'string' || input.spoolPath.length === 0
    || input.spoolPath.includes('\0')) throw fail();
}

function verified(file: drive_v3.Schema$File, input: CommitInput): CommitResult {
  const size = file?.size;
  const numericSize = typeof size === 'string' && /^(0|[1-9][0-9]*)$/.test(size)
    ? Number(size) : typeof size === 'number' ? size : NaN;
  if (!file || file.id !== input.fileId || file.trashed === true
    || !Array.isArray(file.parents) || file.parents.length !== 1
    || file.parents[0] !== input.parent_folder_id
    || !Number.isSafeInteger(numericSize) || numericSize !== input.total_size_bytes
    || (file.md5Checksum != null && (typeof file.md5Checksum !== 'string'
      || file.md5Checksum.toLowerCase() !== input.md5.toLowerCase()))
    || (file.sha256Checksum != null && (typeof file.sha256Checksum !== 'string'
      || file.sha256Checksum.toLowerCase() !== input.sha256.toLowerCase()))) throw fail();
  return { file_id: input.fileId, parents: [input.parent_folder_id], size: numericSize };
}

function locationHeader(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get('location');
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'location');
  return entries.length === 1 ? entries[0][1] : undefined;
}

/** Admit only Drive's HTTPS resumable-session endpoint, never an arbitrary URL. */
function sessionUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384
    || !value.startsWith('https://www.googleapis.com/upload/drive/v3/files?')
    || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw fail();
  let url: URL;
  try { url = new URL(value); } catch { throw fail(); }
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password
    || url.port || url.hash || url.pathname !== '/upload/drive/v3/files') throw fail();
  const allowed = new Set(['uploadType', 'upload_id', 'supportsAllDrives', 'fields']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw fail();
  }
  if (url.searchParams.get('uploadType') !== 'resumable'
    || !/^[A-Za-z0-9_-]{1,8192}$/.test(url.searchParams.get('upload_id') ?? '')
    || (url.searchParams.has('supportsAllDrives') && url.searchParams.get('supportsAllDrives') !== 'true')
    || (url.searchParams.has('fields') && url.searchParams.get('fields') !== UPLOAD_FIELDS)) throw fail();
  return value;
}

/**
 * Binary-only Drive adapter. The relay owns integrity validation, durable ID
 * reservation and spool lifetime; this adapter never deletes or buffers a spool.
 */
export function createDriveRelayProvider(ctx: Pick<ToolContext, 'getDrive' | 'authClient'>): RelayProvider {
  async function readFile(fileId: string): Promise<drive_v3.Schema$File | undefined> {
    try {
      const response = await ctx.getDrive().files.get({
        fileId, fields: RESULT_FIELDS, supportsAllDrives: true,
      }, { retry: false, maxRedirects: 0 });
      if (!response.data || typeof response.data !== 'object') throw fail();
      return response.data;
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      if (error instanceof RelayError) throw error;
      throw fail(canRetry(error));
    }
  }

  async function reconcile(input: CommitInput): Promise<CommitResult> {
    const file = await readFile(input.fileId);
    if (!file) throw fail(true);
    return verified(file, input);
  }

  return {
    async allocateId(): Promise<string> {
      try {
        const response = await ctx.getDrive().files.generateIds({
          count: 1, space: 'drive', type: 'files',
        }, { retry: false, maxRedirects: 0 });
        if (!Array.isArray(response.data.ids) || response.data.ids.length !== 1
          || !validId(response.data.ids[0])) throw fail();
        return response.data.ids[0];
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw fail(canRetry(error));
      }
    },

    async commit(input: CommitInput): Promise<CommitResult> {
      validateInput(input);
      try {
        let parent: drive_v3.Schema$File;
        try {
          const response = await ctx.getDrive().files.get({
            fileId: input.parent_folder_id,
            fields: 'id,mimeType,trashed,capabilities(canAddChildren)',
            supportsAllDrives: true,
          }, { retry: false, maxRedirects: 0 });
          parent = response.data;
        } catch (error) {
          if (statusOf(error) === 403 || statusOf(error) === 404) throw new RelayError('PARENT_INVALID');
          throw fail(canRetry(error));
        }
        if (!parent || parent.id !== input.parent_folder_id || parent.mimeType !== FOLDER_MIME
          || parent.trashed === true
          || (parent.capabilities?.canAddChildren != null && parent.capabilities.canAddChildren !== true)) {
          throw new RelayError('PARENT_INVALID');
        }

        // An ambiguous previous attempt always reconciles the SAME reserved ID.
        // Only a genuine 404 permits initiation; 403/transport faults never do.
        const existing = await readFile(input.fileId);
        if (existing) return verified(existing, input);

        let location: string;
        try {
          const response = await ctx.authClient.request({
            url: UPLOAD_URL,
            method: 'POST',
            data: { id: input.fileId, name: input.filename, parents: [input.parent_folder_id], mimeType: input.mime_type },
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': String(input.total_size_bytes),
              'X-Upload-Content-Type': input.mime_type,
            },
            retry: false, maxRedirects: 0, responseType: 'json',
            // Classify HTTP failures here, not in OAuth2Client: its 401/403
            // refresh-and-replay path otherwise bypasses gaxios retry:false.
            validateStatus: () => true,
          });
          if (response.status === 409) return reconcile(input);
          if (response.status !== 200 && response.status !== 201) throw fail(response.status >= 500 || response.status === 429);
          location = sessionUrl(locationHeader(response.headers));
        } catch (error) {
          if (statusOf(error) === 409) return reconcile(input);
          if (error instanceof RelayError) throw error;
          throw fail(canRetry(error));
        }

        const body = createReadStream(input.spoolPath);
        // File-open faults can occur while the auth client is refreshing a token.
        // Mark them handled immediately; the transport still sees the fault.
        body.on('error', () => {});
        try {
          const response = await ctx.authClient.request({
            url: location, method: 'PUT', data: body,
            headers: {
              'Content-Length': String(input.total_size_bytes),
              'Content-Type': input.mime_type,
              'Content-Range': input.total_size_bytes === 0
                ? 'bytes */0' : `bytes 0-${input.total_size_bytes - 1}/${input.total_size_bytes}`,
            },
            retry: false, maxRedirects: 0, responseType: 'json',
            // Classify HTTP failures here, not in OAuth2Client: its 401/403
            // refresh-and-replay path otherwise bypasses gaxios retry:false.
            validateStatus: () => true,
          });
          if (response.status === 409) return reconcile(input);
          if (response.status !== 200 && response.status !== 201) throw fail(response.status === 308 || response.status >= 500 || response.status === 429);
        } catch (error) {
          if (statusOf(error) === 409) return reconcile(input);
          if (error instanceof RelayError) throw error;
          throw fail(canRetry(error));
        } finally {
          body.destroy();
        }
        // Never trust the upload response as the completion receipt.
        return reconcile(input);
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw fail(canRetry(error));
      }
    },
  };
}

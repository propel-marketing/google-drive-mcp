import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { UploadRelay, RelayError } from '../upload-relay.js';
import { createDriveRelayProvider } from '../upload-drive.js';

type ProviderContext = Pick<ToolContext, 'getDrive' | 'authClient'>;
let contextFactory: (() => ProviderContext) | undefined;
let relay: UploadRelay | undefined;

export function configureUploadRelay(getContext: () => ProviderContext): void {
  contextFactory = getContext;
}

function getRelay(): UploadRelay {
  if (!relay) {
    const provider = createDriveRelayProvider({
      getDrive: () => {
        if (!contextFactory) throw new RelayError('DRIVE_COMMIT_FAILED');
        return contextFactory().getDrive();
      },
      get authClient() {
        if (!contextFactory) throw new RelayError('DRIVE_COMMIT_FAILED');
        return contextFactory().authClient;
      },
    });
    relay = new UploadRelay(provider);
  }
  return relay;
}

export async function startUploadRelay(): Promise<void> {
  try {
    await getRelay().sweep();
  } catch {
    console.error('Upload relay unavailable');
  }
}

export async function closeUploadRelay(): Promise<void> {
  try {
    await relay?.close();
  } catch {
    console.error('Upload relay unavailable');
  }
}

export async function _setUploadRelayForTesting(replacement?: UploadRelay): Promise<void> {
  if (!process.env.MCP_TESTING) throw new Error('Testing only');
  await relay?.close();
  relay = replacement;
}

const beginSchema = z.object({
  filename: z.string().min(1).max(1024),
  parent_folder_id: z.string().min(1).max(1024),
  total_size_bytes: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime_type: z.string().min(1).max(256),
  consumer_label: z.string().min(1).max(256).optional(),
});

const capabilityProperties = {
  upload_id: { type: 'string', description: 'Server-issued upload UUID.' },
  resume_secret: { type: 'string', description: 'Capability returned once by uploadBegin; keep private.' },
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'uploadBegin',
    description: 'Begin a durable binary upload to an explicit Drive folder. Returns upload_id, resume_secret (once only), max_chunk_bytes and expires_at. consumer_label is audit-only.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        parent_folder_id: { type: 'string' },
        total_size_bytes: { type: 'integer', minimum: 0 },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        mime_type: { type: 'string' },
        consumer_label: { type: 'string' },
      },
      required: ['filename', 'parent_folder_id', 'total_size_bytes', 'sha256', 'mime_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'uploadChunk',
    description: 'Write canonical base64 at a byte offset. Exact-range retries permit repair; nonoverlapping out-of-order chunks are supported. Returns status with contiguous received_bytes and next_expected_offset. Default decoded chunk limit is 65536 bytes (87384 base64 characters).',
    inputSchema: {
      type: 'object',
      properties: {
        ...capabilityProperties,
        offset: { type: 'integer', minimum: 0 },
        content_base64: { type: 'string' },
      },
      required: ['upload_id', 'resume_secret', 'offset', 'content_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'uploadStatus',
    description: 'Resume across MCP sessions using the upload capability. Returns upload_id, total_size_bytes, sha256, received_bytes, next_expected_offset, state and expires_at; committed status includes file_id, parents and size; pending commit includes commit_pending.',
    inputSchema: { type: 'object', properties: capabilityProperties, required: ['upload_id', 'resume_secret'], additionalProperties: false },
  },
  {
    name: 'uploadCommit',
    description: 'Verify complete size and SHA256 before uploading to the exact declared Drive folder. Returns file_id, parents and size. Repeated commits return the same receipt without another file.',
    inputSchema: { type: 'object', properties: capabilityProperties, required: ['upload_id', 'resume_secret'], additionalProperties: false },
  },
  {
    name: 'uploadAbort',
    description: 'Abort local upload and release its reservation. Returns status; does not delete a remote file from an earlier commit or ambiguous attempt.',
    inputSchema: { type: 'object', properties: capabilityProperties, required: ['upload_id', 'resume_secret'], additionalProperties: false },
  },
];

function jsonResponse(fields: object, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(fields) }], ...(isError ? { isError: true } : {}) };
}

function publicError(error: unknown, nextOffset?: number): ToolResult {
  if (error instanceof RelayError) {
    if (['SESSION_NOT_FOUND', 'SESSION_EXPIRED', 'SIZE_EXCEEDED', 'HASH_MISMATCH', 'PARENT_INVALID'].includes(error.code)) {
      return jsonResponse({ code: error.code }, true);
    }
    if (error.code === 'SESSION_CLOSED') return jsonResponse({ code: 'SESSION_NOT_FOUND' }, true);
    if (error.code === 'OFFSET_MISMATCH' || error.code === 'INVALID_BASE64') {
      const offset = error.next_expected_offset ?? nextOffset;
      if (Number.isSafeInteger(offset) && offset! >= 0) {
        return jsonResponse({ code: 'OFFSET_MISMATCH', next_expected_offset: offset }, true);
      }
    }
    if (error.code === 'DRIVE_COMMIT_FAILED') {
      return jsonResponse({ code: 'DRIVE_COMMIT_FAILED', retryable: error.retryable === true }, true);
    }
  }
  return jsonResponse({ code: 'DRIVE_COMMIT_FAILED', retryable: false }, true);
}

export async function handleTool(name: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  if (!toolDefinitions.some(tool => tool.name === name)) return null;
  let nextOffset: number | undefined;
  try {
    const activeRelay = getRelay();
    if (name === 'uploadBegin') {
      const declaration = beginSchema.safeParse(args);
      if (!declaration.success) return publicError(undefined);
      return jsonResponse(await activeRelay.begin(declaration.data));
    }
    const capability = {
      upload_id: typeof args.upload_id === 'string' ? args.upload_id : '',
      resume_secret: typeof args.resume_secret === 'string' ? args.resume_secret : undefined,
    };
    const status = await activeRelay.status(capability);
    nextOffset = status.next_expected_offset;
    if (name === 'uploadStatus') return jsonResponse(status);
    if (name === 'uploadCommit') return jsonResponse(await activeRelay.commit(capability));
    if (name === 'uploadAbort') return jsonResponse(await activeRelay.abort(capability));
    if (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0
      || typeof args.content_base64 !== 'string') {
      return publicError(new RelayError('OFFSET_MISMATCH', { next_expected_offset: nextOffset }));
    }
    return jsonResponse(await activeRelay.chunk({ ...capability, offset: args.offset, content_base64: args.content_base64 }));
  } catch (error) {
    return publicError(error, nextOffset);
  }
}

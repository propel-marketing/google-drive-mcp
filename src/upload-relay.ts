import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class RelayError extends Error {
  readonly code: string;
  readonly retryable?: boolean;
  readonly next_expected_offset?: number;

  constructor(code: string, options: { retryable?: boolean; next_expected_offset?: number } = {}) {
    super(code);
    this.name = 'RelayError';
    this.code = code;
    this.retryable = options.retryable;
    this.next_expected_offset = options.next_expected_offset;
  }
}

export interface RelayProvider {
  allocateId(): Promise<string>;
  commit(input: {
    fileId: string;
    filename: string;
    parent_folder_id: string;
    mime_type: string;
    total_size_bytes: number;
    sha256: string;
    md5: string;
    spoolPath: string;
  }): Promise<{ file_id: string; parents: string[]; size: number }>;
}

export interface RelayConfig {
  spoolDir: string;
  maxSessionBytes: number;
  maxGlobalBytes: number;
  maxChunkBytes: number;
  ttlMs: number;
  sweepIntervalMs: number;
  maxSessions: number;
}

type BeginInput = {
  filename: string;
  parent_folder_id: string;
  total_size_bytes: number;
  sha256: string;
  mime_type: string;
  consumer_label?: string;
};
type Capability = { upload_id: string; resume_secret?: string };
type ChunkRange = { start: number; end: number; sha256: string };
type CommitReceipt = { file_id: string; parents: string[]; size: number };
type SessionState = 'open' | 'committing' | 'committed' | 'aborted' | 'expired';
type Session = BeginInput & {
  version: 1;
  upload_id: string;
  secret_hash: string;
  state: SessionState;
  expires_at: number;
  terminal_at?: number;
  ranges: ChunkRange[];
  fileId?: string;
  receipt?: CommitReceipt;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RANGES = 65536;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_TIMER_MS = 2147483647;
const ownedSpools = new Set<string>();

function defaults(): RelayConfig {
  return {
    spoolDir: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-drive-mcp', 'upload-relay'),
    maxSessionBytes: 1024 ** 3,
    maxGlobalBytes: 4 * 1024 ** 3,
    maxChunkBytes: 64 * 1024,
    ttlMs: 24 * 60 * 60 * 1000,
    sweepIntervalMs: 60 * 1000,
    maxSessions: 1024,
  };
}

function validateConfig(config: RelayConfig): RelayConfig {
  if (typeof config.spoolDir !== 'string' || !path.isAbsolute(config.spoolDir) || config.spoolDir.includes('\0')) {
    throw new RelayError('RELAY_CONFIG_INVALID');
  }
  for (const key of ['maxSessionBytes', 'maxGlobalBytes', 'maxChunkBytes', 'ttlMs', 'sweepIntervalMs', 'maxSessions'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new RelayError('RELAY_CONFIG_INVALID');
  }
  if (config.maxSessionBytes > config.maxGlobalBytes ||
      config.sweepIntervalMs > MAX_TIMER_MS || config.maxSessions > 100000 ||
      config.maxChunkBytes > 64 * 1024 * 1024 || config.ttlMs > 8640000000000000 - Date.now()) {
    throw new RelayError('RELAY_CONFIG_INVALID');
  }
  return { ...config, spoolDir: path.resolve(config.spoolDir) };
}

export function relayConfigFromEnv(): RelayConfig {
  const config = defaults();
  if (process.env.UPLOAD_RELAY_SPOOL_DIR !== undefined) config.spoolDir = process.env.UPLOAD_RELAY_SPOOL_DIR;
  const envKeys = {
    maxSessionBytes: 'UPLOAD_RELAY_MAX_SESSION_BYTES',
    maxGlobalBytes: 'UPLOAD_RELAY_MAX_GLOBAL_BYTES',
    maxChunkBytes: 'UPLOAD_RELAY_MAX_CHUNK_BYTES',
    ttlMs: 'UPLOAD_RELAY_TTL_MS',
    sweepIntervalMs: 'UPLOAD_RELAY_SWEEP_INTERVAL_MS',
    maxSessions: 'UPLOAD_RELAY_MAX_SESSIONS',
  } as const;
  for (const key of Object.keys(envKeys) as (keyof typeof envKeys)[]) {
    const value = process.env[envKeys[key]];
    if (value !== undefined) {
      if (!/^[0-9]+$/.test(value)) throw new RelayError('RELAY_CONFIG_INVALID');
      config[key] = Number(value);
    }
  }
  return validateConfig(config);
}

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

function validDeclaration(input: BeginInput): boolean {
  return !!input && boundedText(input.filename, 1024) && boundedText(input.parent_folder_id, 1024) &&
    boundedText(input.mime_type, 256) && Number.isSafeInteger(input.total_size_bytes) && input.total_size_bytes >= 0 &&
    typeof input.sha256 === 'string' && SHA256.test(input.sha256) &&
    (input.consumer_label === undefined || boundedText(input.consumer_label, 256));
}

function publicState(state: SessionState): Exclude<SessionState, 'committing'> {
  return state === 'committing' ? 'open' : state;
}

export class UploadRelay {
  private readonly config: RelayConfig;
  private readonly sessions = new Map<string, Session>();
  private reservedBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private lockToken?: string;
  private lockIdentity?: { dev: number; ino: number };
  private storageFailed = false;

  constructor(private readonly provider: RelayProvider, config: Partial<RelayConfig> = {}) {
    this.config = validateConfig({ ...relayConfigFromEnv(), ...config });
  }

  private run<T>(operation: () => Promise<T> | T): Promise<T> {
    const execution = this.queue.then(async () => {
      if (this.closed) throw new RelayError('RELAY_CLOSED');
      if (this.storageFailed) throw new RelayError('RELAY_STORAGE_FAILED');
      try {
        this.initialize();
        this.assertOwnership();
        return await operation();
      } catch (error) {
        if (error instanceof RelayError) throw error;
        this.storageFailed = true;
        throw new RelayError('RELAY_STORAGE_FAILED');
      }
    });
    this.queue = execution.catch(() => undefined);
    return execution;
  }

  private directory(uploadId: string): string {
    if (!UUID.test(uploadId)) throw new RelayError('SESSION_NOT_FOUND');
    return path.join(this.config.spoolDir, uploadId);
  }

  private spoolPath(session: Session): string {
    return path.join(this.directory(session.upload_id), 'content');
  }

  private assertPrivate(location: string, directory: boolean): fs.Stats {
    const stat = fs.lstatSync(location);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
      throw new RelayError('RELAY_STORAGE_UNSAFE');
    }
    return stat;
  }

  private syncDirectory(location: string): void {
    const descriptor = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }

  private validateDirectoryChain(): void {
    const root = path.parse(this.config.spoolDir).root;
    let current = root;
    for (const component of this.config.spoolDir.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RelayError('RELAY_STORAGE_UNSAFE');
    }
    this.assertPrivate(this.config.spoolDir, true);
  }

  private createSpoolDirectory(): void {
    const root = path.parse(this.config.spoolDir).root;
    let current = root;
    for (const component of this.config.spoolDir.slice(root.length).split(path.sep).filter(Boolean)) {
      const parent = current;
      current = path.join(parent, component);
      try { fs.mkdirSync(current, { mode: 0o700 }); this.syncDirectory(parent); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RelayError('RELAY_STORAGE_UNSAFE');
    }
    this.assertPrivate(this.config.spoolDir, true);
  }

  private initialize(): void {
    if (this.initialized) return;
    this.createSpoolDirectory();
    if (ownedSpools.has(this.config.spoolDir)) throw new RelayError('RELAY_SPOOL_LOCKED');
    this.acquireLock();
    ownedSpools.add(this.config.spoolDir);
    try {
      this.loadSessions();
      this.initialized = true;
      this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, this.config.sweepIntervalMs);
      this.timer.unref();
    } catch (error) {
      this.releaseLock();
      this.sessions.clear();
      this.reservedBytes = 0;
      throw error;
    }
  }

  private readPrivate(location: string, maximum: number): string {
    this.assertPrivate(location, false);
    const descriptor = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > maximum) throw new RelayError('RELAY_STORAGE_UNSAFE');
      return fs.readFileSync(descriptor, 'utf8');
    } finally { fs.closeSync(descriptor); }
  }

  private acquireLock(): void {
    const lockPath = path.join(this.config.spoolDir, '.owner');
    if (fs.existsSync(lockPath)) this.recoverDeadOwner(lockPath);
    const token = randomUUID();
    let descriptor: number;
    try { descriptor = fs.openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RelayError('RELAY_SPOOL_LOCKED');
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      this.lockToken = token;
      this.lockIdentity = { dev: stat.dev, ino: stat.ino };
    } finally { fs.closeSync(descriptor); }
    this.syncDirectory(this.config.spoolDir);
  }

  private recoverDeadOwner(lockPath: string): void {
    const owner = JSON.parse(this.readPrivate(lockPath, 4096)) as { pid?: number; host?: string; token?: string };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.host !== os.hostname() || typeof owner.token !== 'string') {
      throw new RelayError('RELAY_SPOOL_LOCKED');
    }
    try { process.kill(owner.pid!, 0); throw new RelayError('RELAY_SPOOL_LOCKED'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new RelayError('RELAY_SPOOL_LOCKED');
    }
    const recoveryPath = path.join(this.config.spoolDir, '.recovery');
    let recovery: number;
    try { recovery = fs.openSync(recoveryPath, 'wx', 0o600); }
    catch { throw new RelayError('RELAY_SPOOL_LOCKED'); }
    try {
      const current = JSON.parse(this.readPrivate(lockPath, 4096)) as { token?: string };
      if (current.token !== owner.token) throw new RelayError('RELAY_SPOOL_LOCKED');
      fs.unlinkSync(lockPath);
      this.syncDirectory(this.config.spoolDir);
    } finally {
      fs.closeSync(recovery);
      fs.unlinkSync(recoveryPath);
    }
  }

  private assertOwnership(): void {
    this.validateDirectoryChain();
    const lockPath = path.join(this.config.spoolDir, '.owner');
    const stat = this.assertPrivate(lockPath, false);
    if (stat.dev !== this.lockIdentity?.dev || stat.ino !== this.lockIdentity?.ino) throw new RelayError('RELAY_SPOOL_LOCKED');
  }

  private releaseLock(): void {
    if (!this.lockToken) return;
    try {
      this.assertOwnership();
      fs.unlinkSync(path.join(this.config.spoolDir, '.owner'));
      this.syncDirectory(this.config.spoolDir);
    } finally {
      this.lockToken = undefined;
      this.lockIdentity = undefined;
      ownedSpools.delete(this.config.spoolDir);
    }
  }

  private persist(session: Session): void {
    const directory = this.directory(session.upload_id);
    this.assertPrivate(directory, true);
    const serialized = JSON.stringify(session);
    if (Buffer.byteLength(serialized) > MAX_METADATA_BYTES) throw new RelayError('SIZE_EXCEEDED');
    const stagedPath = path.join(directory, 'session.next');
    const descriptor = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(descriptor, serialized);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(stagedPath, path.join(directory, 'session.json'));
    this.syncDirectory(directory);
    this.sessions.set(session.upload_id, session);
  }

  private validSession(session: Session, uploadId: string): boolean {
    if (!session || !validDeclaration(session) || session.version !== 1 || session.upload_id !== uploadId ||
        typeof session.secret_hash !== 'string' || !SHA256.test(session.secret_hash) ||
        !['open', 'committing', 'committed', 'aborted', 'expired'].includes(session.state) ||
        !Number.isSafeInteger(session.expires_at) || session.expires_at <= 0 || !Array.isArray(session.ranges) ||
        session.ranges.length > MAX_RANGES || (session.fileId !== undefined && !boundedText(session.fileId, 1024))) return false;
    let previousEnd = 0;
    for (const range of session.ranges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previousEnd ||
          range.end <= range.start || range.end > session.total_size_bytes || !SHA256.test(range.sha256)) return false;
      previousEnd = range.end;
    }
    if ((session.state === 'committing' || session.state === 'committed') &&
        (!session.fileId || this.contiguous(session) !== session.total_size_bytes)) return false;
    // A terminal receipt may retain the reserved ID from an ambiguous attempt;
    // only an open, mutable upload must never carry a commit reservation.
    if (session.state === 'open' && session.fileId !== undefined) return false;
    if (session.state !== 'committed' && session.receipt !== undefined) return false;
    if ((session.state === 'open' || session.state === 'committing') && session.terminal_at !== undefined) return false;
    if (session.state === 'committed' && !this.validReceipt(session.receipt, session)) return false;
    if (['committed', 'aborted', 'expired'].includes(session.state) &&
        (!Number.isSafeInteger(session.terminal_at) || session.terminal_at! <= 0)) return false;
    return true;
  }

  private loadSessions(): void {
    const entries = fs.readdirSync(this.config.spoolDir);
    if (entries.length > this.config.maxSessions + 1) throw new RelayError('SIZE_EXCEEDED');
    for (const uploadId of entries) {
      if (uploadId === '.owner') continue;
      if (!UUID.test(uploadId)) throw new RelayError('RELAY_STORAGE_UNSAFE');
      const directory = this.directory(uploadId);
      this.assertPrivate(directory, true);
      const children = fs.readdirSync(directory);
      if (children.some(name => !['content', 'session.json', 'session.next'].includes(name))) throw new RelayError('RELAY_STORAGE_UNSAFE');
      for (const child of children) this.assertPrivate(path.join(directory, child), false);
      const metadataPath = path.join(directory, 'session.json');
      if (!children.includes('session.json')) {
        this.removeSessionDirectory(uploadId);
        continue;
      }
      const session = JSON.parse(this.readPrivate(metadataPath, MAX_METADATA_BYTES)) as Session;
      if (!this.validSession(session, uploadId)) throw new RelayError('RELAY_STORAGE_UNSAFE');
      if (children.includes('session.next')) fs.unlinkSync(path.join(directory, 'session.next'));
      if (session.state === 'open' || session.state === 'committing') {
        this.reconcileContent(session);
        this.reservedBytes += session.total_size_bytes;
        if (!Number.isSafeInteger(this.reservedBytes) || this.reservedBytes > this.config.maxGlobalBytes ||
            session.total_size_bytes > this.config.maxSessionBytes) throw new RelayError('SIZE_EXCEEDED');
      } else {
        this.deleteContent(session);
      }
      this.sessions.set(uploadId, session);
    }
  }

  private reconcileContent(session: Session): void {
    const location = this.spoolPath(session);
    const stat = this.assertPrivate(location, false);
    if (stat.size > session.total_size_bytes) throw new RelayError('RELAY_STORAGE_UNSAFE');
    const descriptor = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let verifiedRanges: ChunkRange[];
    try {
      verifiedRanges = session.ranges.filter(range => range.end <= stat.size && this.hashRange(descriptor, range.start, range.end).sha256 === range.sha256);
    } finally { fs.closeSync(descriptor); }
    if (verifiedRanges.length !== session.ranges.length) {
      if (session.state === 'committing') throw new RelayError('RELAY_STORAGE_UNSAFE');
      session.ranges = verifiedRanges;
      this.persist(session);
    }
  }

  private hashRange(descriptor: number, start: number, end: number): { sha256: string; md5: string } {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, end - start)));
    let offset = start;
    while (offset < end) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (count === 0) throw new RelayError('HASH_MISMATCH');
      sha256.update(buffer.subarray(0, count));
      md5.update(buffer.subarray(0, count));
      offset += count;
    }
    return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
  }

  private contiguous(session: Session): number {
    let received = 0;
    for (const range of session.ranges) {
      if (range.start !== received) break;
      received = range.end;
    }
    return received;
  }

  private authenticate(input: Capability): Session {
    const uploadId = input?.upload_id;
    const secret = input?.resume_secret;
    const session = typeof uploadId === 'string' && UUID.test(uploadId) ? this.sessions.get(uploadId) : undefined;
    const suppliedHash = digest(typeof secret === 'string' && secret.length <= 256 ? secret : '');
    const expectedHash = session?.secret_hash ?? '0'.repeat(64);
    const authenticated = timingSafeEqual(Buffer.from(suppliedHash, 'hex'), Buffer.from(expectedHash, 'hex'));
    if (!session || typeof secret !== 'string' || !authenticated) throw new RelayError('SESSION_NOT_FOUND');
    return session;
  }

  private expire(session: Session): Session {
    if ((session.state === 'open' || session.state === 'committing') && session.expires_at <= Date.now()) return this.terminate(session, 'expired');
    return session;
  }

  private requireOpen(session: Session): void {
    if (session.state === 'expired') throw new RelayError('SESSION_EXPIRED');
    if (session.state === 'committing') throw new RelayError('DRIVE_COMMIT_FAILED', { retryable: true });
    if (session.state !== 'open') throw new RelayError('SESSION_CLOSED');
  }

  private statusReceipt(session: Session) {
    const received = this.contiguous(session);
    return {
      upload_id: session.upload_id,
      total_size_bytes: session.total_size_bytes,
      sha256: session.sha256,
      received_bytes: received,
      next_expected_offset: received,
      state: publicState(session.state),
      expires_at: new Date(session.expires_at).toISOString(),
      ...(session.state === 'committing' ? { commit_pending: true } : {}),
      ...(session.receipt ? { file_id: session.receipt.file_id, parents: [...session.receipt.parents], size: session.receipt.size } : {}),
    };
  }

  async begin(input: BeginInput) {
    return this.run(() => {
      if (!validDeclaration(input)) throw new RelayError('INVALID_ARGUMENT');
      this.sweepInternal();
      if (input.total_size_bytes > this.config.maxSessionBytes ||
          input.total_size_bytes > this.config.maxGlobalBytes - this.reservedBytes ||
          this.sessions.size >= this.config.maxSessions) throw new RelayError('SIZE_EXCEEDED');
      const uploadId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      const session: Session = {
        version: 1,
        upload_id: uploadId,
        filename: input.filename,
        parent_folder_id: input.parent_folder_id,
        total_size_bytes: input.total_size_bytes,
        sha256: input.sha256,
        mime_type: input.mime_type,
        ...(input.consumer_label === undefined ? {} : { consumer_label: input.consumer_label }),
        secret_hash: digest(secret),
        state: 'open',
        expires_at: Date.now() + this.config.ttlMs,
        ranges: [],
      };
      const directory = this.directory(uploadId);
      fs.mkdirSync(directory, { mode: 0o700 });
      this.syncDirectory(this.config.spoolDir);
      const descriptor = fs.openSync(this.spoolPath(session), 'wx', 0o600);
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      this.persist(session);
      this.reservedBytes += input.total_size_bytes;
      return { upload_id: uploadId, resume_secret: secret, max_chunk_bytes: this.config.maxChunkBytes, expires_at: new Date(session.expires_at).toISOString() };
    });
  }

  async chunk(input: Capability & { offset: number; content_base64: string }) {
    return this.run(() => {
      const session = this.expire(this.authenticate(input));
      this.requireOpen(session);
      const content = input.content_base64;
      if (typeof content === 'string' && content.length > 4 * Math.ceil(this.config.maxChunkBytes / 3)) {
        throw new RelayError('SIZE_EXCEEDED');
      }
      if (typeof content !== 'string' || content.length === 0 || content.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
        throw new RelayError('INVALID_BASE64');
      }
      const bytes = Buffer.from(content, 'base64');
      if (bytes.toString('base64') !== content) throw new RelayError('INVALID_BASE64');
      if (bytes.length > this.config.maxChunkBytes) throw new RelayError('SIZE_EXCEEDED');
      const end = input.offset + bytes.length;
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(end)) {
        throw new RelayError('OFFSET_MISMATCH', { next_expected_offset: this.contiguous(session) });
      }
      if (end > session.total_size_bytes) throw new RelayError('SIZE_EXCEEDED');
      const overlap = session.ranges.find(range => input.offset < range.end && end > range.start);
      if (overlap && (overlap.start !== input.offset || overlap.end !== end)) {
        throw new RelayError('OFFSET_MISMATCH', { next_expected_offset: this.contiguous(session) });
      }
      if (!overlap && session.ranges.length >= MAX_RANGES) throw new RelayError('SIZE_EXCEEDED');
      const directory = this.directory(session.upload_id);
      this.assertPrivate(directory, true);
      this.assertPrivate(this.spoolPath(session), false);
      const descriptor = fs.openSync(this.spoolPath(session), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        let written = 0;
        while (written < bytes.length) {
          const count = fs.writeSync(descriptor, bytes, written, bytes.length - written, input.offset + written);
          if (count === 0) throw new RelayError('RELAY_STORAGE_FAILED');
          written += count;
        }
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      const updated: Session = { ...session, ranges: session.ranges.filter(range => range !== overlap).concat({ start: input.offset, end, sha256: digest(bytes) }).sort((left, right) => left.start - right.start) };
      this.persist(updated);
      return this.statusReceipt(updated);
    });
  }

  async status(input: Capability) {
    return this.run(() => this.statusReceipt(this.expire(this.authenticate(input))));
  }

  private async verifyIntegrity(session: Session): Promise<{ sha256: string; md5: string }> {
    if (this.contiguous(session) !== session.total_size_bytes) throw new RelayError('HASH_MISMATCH');
    this.assertPrivate(this.directory(session.upload_id), true);
    const stat = this.assertPrivate(this.spoolPath(session), false);
    if (stat.size !== session.total_size_bytes) throw new RelayError('HASH_MISMATCH');
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    let verifiedBytes = 0;
    const stream = fs.createReadStream(this.spoolPath(session), {
      fd: fs.openSync(this.spoolPath(session), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
      autoClose: true,
      highWaterMark: 1024 * 1024,
    });
    for await (const bytes of stream) {
      verifiedBytes += bytes.length;
      if (verifiedBytes > session.total_size_bytes) throw new RelayError('HASH_MISMATCH');
      sha256.update(bytes);
      md5.update(bytes);
    }
    const hashes = { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
    if (verifiedBytes !== session.total_size_bytes || hashes.sha256 !== session.sha256) throw new RelayError('HASH_MISMATCH');
    return hashes;
  }

  private validReceipt(receipt: CommitReceipt | undefined, session: Session): receipt is CommitReceipt {
    return !!receipt && receipt.file_id === session.fileId && receipt.size === session.total_size_bytes &&
      Array.isArray(receipt.parents) && receipt.parents.length === 1 && receipt.parents[0] === session.parent_folder_id;
  }

  async commit(input: Capability): Promise<CommitReceipt> {
    return this.run(async () => {
      let session = this.expire(this.authenticate(input));
      if (session.state === 'committed') return { ...session.receipt!, parents: [...session.receipt!.parents] };
      if (session.state !== 'committing') this.requireOpen(session);
      const hashes = await this.verifyIntegrity(session);
      if (!session.fileId) {
        let fileId: string;
        try { fileId = await this.provider.allocateId(); }
        catch (error) { throw this.providerError(error); }
        if (!boundedText(fileId, 1024)) throw new RelayError('DRIVE_COMMIT_FAILED', { retryable: true });
        session = { ...session, fileId, state: 'committing' };
        this.persist(session);
      }
      let receipt: CommitReceipt;
      try {
        receipt = await this.provider.commit({
          fileId: session.fileId!, filename: session.filename, parent_folder_id: session.parent_folder_id,
          mime_type: session.mime_type, total_size_bytes: session.total_size_bytes, sha256: hashes.sha256,
          md5: hashes.md5, spoolPath: this.spoolPath(session),
        });
      } catch (error) { throw this.providerError(error); }
      if (!this.validReceipt(receipt, session)) throw new RelayError('DRIVE_COMMIT_FAILED', { retryable: true });
      const committed: Session = {
        ...session, state: 'committed', terminal_at: Date.now(),
        receipt: { file_id: receipt.file_id, parents: [...receipt.parents], size: receipt.size },
      };
      this.persist(committed);
      this.reservedBytes -= session.total_size_bytes;
      this.deleteContent(committed);
      return { ...committed.receipt!, parents: [...committed.receipt!.parents] };
    });
  }

  private providerError(error: unknown): RelayError {
    return error instanceof RelayError ? error : new RelayError('DRIVE_COMMIT_FAILED', { retryable: true });
  }

  private deleteContent(session: Session): void {
    this.assertPrivate(this.directory(session.upload_id), true);
    const location = this.spoolPath(session);
    try { this.assertPrivate(location, false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    fs.unlinkSync(location);
    this.syncDirectory(this.directory(session.upload_id));
  }

  private terminate(session: Session, state: 'aborted' | 'expired'): Session {
    const terminal: Session = { ...session, state, terminal_at: Date.now() };
    this.persist(terminal);
    this.reservedBytes -= session.total_size_bytes;
    this.deleteContent(terminal);
    return terminal;
  }

  async abort(input: Capability) {
    return this.run(() => {
      const session = this.expire(this.authenticate(input));
      // Serialized after any in-flight commit: abort prevents future retries,
      // but cannot undo a remote file created by an earlier ambiguous attempt.
      return this.statusReceipt(session.state === 'open' || session.state === 'committing'
        ? this.terminate(session, 'aborted') : session);
    });
  }

  private removeSessionDirectory(uploadId: string): void {
    const directory = this.directory(uploadId);
    this.assertPrivate(directory, true);
    for (const name of fs.readdirSync(directory)) {
      if (!['content', 'session.json', 'session.next'].includes(name)) throw new RelayError('RELAY_STORAGE_UNSAFE');
      const location = path.join(directory, name);
      this.assertPrivate(location, false);
      fs.unlinkSync(location);
    }
    fs.rmdirSync(directory);
    this.syncDirectory(this.config.spoolDir);
  }

  private sweepInternal(): void {
    const now = Date.now();
    for (const stored of this.sessions.values()) {
      const session = this.expire(stored);
      if (session.state === 'committing' || session.state === 'open') continue;
      this.deleteContent(session);
      if (session.terminal_at! + this.config.ttlMs <= now) {
        this.removeSessionDirectory(session.upload_id);
        this.sessions.delete(session.upload_id);
      }
    }
  }

  async sweep(): Promise<void> {
    return this.run(() => this.sweepInternal());
  }

  async close(): Promise<void> {
    const closing = this.queue.then(() => {
      if (this.closed) return;
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      try { this.releaseLock(); }
      catch { throw new RelayError('RELAY_STORAGE_FAILED'); }
    });
    this.queue = closing.catch(() => undefined);
    return closing;
  }
}

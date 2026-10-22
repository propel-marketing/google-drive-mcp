# Durable binary upload relay

The relay adds `uploadBegin`, `uploadChunk`, `uploadStatus`, `uploadCommit`, and `uploadAbort` to the existing tool domains. It transfers client-held bytes without requiring a server-visible client filesystem path. Existing `uploadFile` and authentication remain unchanged; there are no new dependencies or authentication modes. The implementation is in `src/upload-relay.ts`, `src/upload-drive.ts`, `src/tools/upload.ts`, and the startup/registration wiring in `src/index.ts`.

This is an offline engineering description, not Coordinator qualification, deployment approval, evidence of a deployed relay, or completion of the eight live Radar acceptance tests. Existing named UUID debt is unchanged.

## Tool contract

All argument objects disallow additional properties in the advertised schemas. Integer inputs must be safe integers. The signatures below describe JSON argument/result objects, not positional MCP calls. All fields are required unless marked `?`.

```typescript
uploadBegin({
  filename: string,
  parent_folder_id: string,
  total_size_bytes: number,
  sha256: string,
  mime_type: string,
  consumer_label?: string
}) -> {
  upload_id: string,
  resume_secret: string,
  max_chunk_bytes: number,
  expires_at: string
}

uploadChunk({
  upload_id: string,
  resume_secret: string,
  offset: number,
  content_base64: string
}) -> Status

uploadStatus({ upload_id: string, resume_secret: string }) -> Status
uploadCommit({ upload_id: string, resume_secret: string }) -> {
  file_id: string, parents: string[], size: number
}
uploadAbort({ upload_id: string, resume_secret: string }) -> Status

type Status = {
  upload_id: string,
  total_size_bytes: number,
  sha256: string,
  received_bytes: number,
  next_expected_offset: number,
  state: 'open' | 'committed' | 'aborted' | 'expired',
  expires_at: string,
  commit_pending?: true,
  file_id?: string,
  parents?: string[],
  size?: number
}
```

`expires_at` is an ISO-8601 UTC timestamp. Sizes and offsets are decoded byte counts. `parents` in a successful commit receipt is exactly the one declared folder ID. The three receipt fields appear together in committed status; `commit_pending: true` appears only for pending commit intent, whose public `state` remains `open`. These optional fields are omitted otherwise, not returned as null.

MCP results contain one text content entry whose `text` is JSON. The success envelope is `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. Tool failures use the same envelope with `isError: true`; the public JSON error shapes are listed below. HTTP/parser/JSON-RPC refusals can happen before a relay tool is entered and are not relay errors.

### Declaration and destination

- `filename` and `parent_folder_id`: nonempty, at most 1,024 UTF-8 bytes each. `mime_type` and optional `consumer_label`: nonempty, at most 256 UTF-8 bytes each. These texts reject ASCII control characters and DEL.
- `total_size_bytes`: nonnegative safe integer within configured reservations; zero-byte files need no chunks.
- `sha256`: exactly 64 **lowercase** hexadecimal characters for the complete original binary bytes. Do not hash the base64 text.
- `consumer_label` is audit-only metadata. It is not identity, authentication, authorization, a tenant boundary, or a reservation partition; do not put secrets in it.
- Supply an explicit real Drive folder ID, not a path or the `root` alias. At commit, the provider requires an ID matching `[A-Za-z0-9_-]{1,256}`, verifies the folder ID, folder MIME type, non-trashed state and `canAddChildren` when supplied. A 403/404 folder lookup is `PARENT_INVALID`; there is no fallback to root.
- Use a bare `type/subtype` MIME value such as `application/octet-stream` or `text/csv`, without parameters such as `; charset=utf-8`. Native `application/vnd.google-apps.*` conversion is unsupported. A binary CSV remains binary CSV with its declared filename unchanged, including its extension. Begin stores the declaration; provider-specific MIME/destination checks occur at commit, so begin is not destination validation.

## Capability custody and client flow

`upload_id` is a server-generated UUID. `resume_secret` is 32 random bytes (256 bits), encoded as unpadded base64url, and returned **once**, only from begin. The server persists only its SHA-256 digest, never the plaintext secret, and does not log the secret. Status cannot recover it. Clients must privately retain the capability pair, including across client restarts, and keep it separate from the shared artifact, shared reports, logs and transcripts. Protect both the raw capability and request/response captures containing it. Do not place it in URLs or public examples. If custody is lost, the secret cannot be reissued; a new upload is required.

1. Compute the source byte size and lowercase SHA-256 locally. Choose the actual authorized folder ID and binary MIME type; call begin.
2. Privately capture the returned capability pair and advertised decoded chunk limit. Send chunks as described below.
3. After interruption or a new MCP connection, initialize a fresh MCP session normally, then call status with the **same upload capability**. Upload capability lifetime is independent of an HTTP `mcp-session-id`; all HTTP sessions share the process-wide relay. A persistent spool permits recovery after process restart.
4. Resume at the reported contiguous offset, using your original chunk boundaries for retries/repairs. Retain a local chunk/range ledger if using out-of-order writes: status does not enumerate remote ranges.
5. Commit after complete coverage. Keep the successful Drive receipt separately from the private capability. Repeating commit with the same pair returns the same receipt while retained.
6. Abort when abandoning a transfer. This cleans local active state, not a remote object.

Missing or wrong secrets, unknown/malformed upload IDs, and removed records all return exactly `SESSION_NOT_FOUND`, without state disclosure after capability authentication. Losing an HTTP session does not require losing the upload: reconnect and supply the retained pair.

## Chunks, offsets, retries and repair

Encode each nonempty chunk with canonical standard base64 (`A-Z`, `a-z`, `0-9`, `+`, `/`, required trailing `=` padding where applicable). No whitespace, base64url alphabet, missing/excess padding, or noncanonical residual bits are accepted. Decoding and re-encoding must reproduce the exact supplied string.

`offset` is the zero-based start byte; a chunk covers `[offset, offset + decoded_length)`. It may not extend beyond the declared file size or exceed `max_chunk_bytes`. Nonoverlapping chunks may arrive out of order. A retry must cover the **exact same start and end** as the stored range; it can overwrite that range with identical bytes or corrected bytes. Partial overlap, merging existing ranges, or changing an existing range's end is rejected. Each session permits at most 65,536 tracked ranges; retries replace rather than add a range.

`received_bytes` and `next_expected_offset` both describe the highest contiguous prefix beginning at zero, not the sum of all accepted bytes. Sending later chunks first can leave both at zero. Fill gaps before commit. A missing range, wrong size or wrong whole-file hash gives `HASH_MISMATCH` and keeps an open spool for repair: resend corrected bytes on the exact original ranges and commit again. Declaration fields cannot be changed; abort and begin anew if the declared size/hash/destination is wrong.

Once durable commit intent exists, chunk mutation is blocked (`DRIVE_COMMIT_FAILED`, `retryable: true`); pending bytes are immutable for retries. **Abort and TTL expiry still clean pending sessions** and release reservations. Operations, including provider commit, are serialized, so cleanup waits behind an in-flight operation; expiry is not a cancellation deadline.

## Commit and remote ambiguity

Before any Drive write, the relay checks contiguous coverage, exact spool size, and whole-file SHA-256, and computes MD5. It then allocates a Drive file ID and durably records that same ID with pending intent before invoking the provider. The provider verifies the exact folder, checks for an existing object at the reserved ID, initiates a real Drive resumable upload with POST, and streams the spool in a PUT rather than buffering the whole file. It performs a final file read: ID, exact size and exactly the declared parent must match; MD5 and SHA-256 checksums are checked when Drive supplies them. Only a verified receipt permits successful content deletion/reservation release.

A failed or ambiguous remote attempt retains pending intent and the same generated file ID. Retry commit with the existing capability rather than starting a new upload. Reconciliation and subsequent attempts use that ID, so the session targets at most one Drive object, not a new object on every retry. This does not promise that every ambiguous outcome resolves successfully or that separately begun sessions are deduplicated. Provider exceptions are sanitized, not returned verbatim.

Abort, expiry and image rollback **do not delete or roll back a Drive object** already created by a successful or ambiguous attempt. After abandoning a pending session, remote reconciliation/remediation is an operator task under separate authority. A fresh begin is not a safe substitute for reconciling a possibly created remote object.

Committed, aborted and expired records remain for one configured TTL after their terminal transition. Content is deleted and reservations released on the transition; terminal records still count toward the session cap until swept. Repeated commit is idempotent **within receipt retention**, not forever. After removal the capability returns `SESSION_NOT_FOUND`. The original expiry is fixed at begin, not refreshed by activity. An authenticated expired status can report `state: 'expired'`; attempts to chunk/commit it return `SESSION_EXPIRED` while its record remains.

## Public error JSON

Only these seven codes are public relay tool errors; internal engine/storage codes are not an additional client vocabulary.

| JSON result | Meaning / response |
| --- | --- |
| `{ "code": "SESSION_NOT_FOUND" }` | Unknown record, invalid/missing capability, or a closed-session mutation mapped to this public refusal. Check private custody; never infer existence from refusal. |
| `{ "code": "SESSION_EXPIRED" }` | Authenticated expired record cannot accept chunk/commit; a new session is required. |
| `{ "code": "OFFSET_MISMATCH", "next_expected_offset": number }` | Invalid offset, partial overlap or invalid canonical base64. Inspect encoding and exact range boundaries; the offset is the contiguous prefix. |
| `{ "code": "SIZE_EXCEEDED" }` | Session/global reservation, decoded chunk, declared end, session count, range count or metadata bound exceeded. |
| `{ "code": "HASH_MISMATCH" }` | Incomplete coverage or size/hash mismatch before Drive writes. Repair the retained open spool. |
| `{ "code": "PARENT_INVALID" }` | Explicit parent is invalid, inaccessible, trashed, not a folder or unable to accept children when reported. No root fallback. |
| `{ "code": "DRIVE_COMMIT_FAILED", "retryable": boolean }` | Sanitized provider failure or generic argument/config/storage refusal. `true` permits retry with the same capability; `false` is not a claim that no remote effect happened. Inspect state/operator readiness, not raw provider messages. |

In particular, malformed begin arguments and unavailable relay storage can produce the generic nonretryable failure; not every such result means a Drive request was attempted. Aborting an already committed record returns its committed status, without deleting its file.

## Configuration and budgets

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `UPLOAD_RELAY_SPOOL_DIR` | `~/.config/google-drive-mcp/upload-relay` | Absolute dedicated spool path. Without override, a nonempty `XDG_CONFIG_HOME` replaces `~/.config`. |
| `UPLOAD_RELAY_MAX_SESSION_BYTES` | `1073741824` (1 GiB) | Maximum declared bytes per active upload. |
| `UPLOAD_RELAY_MAX_GLOBAL_BYTES` | `4294967296` (4 GiB) | Sum of active declared-byte reservations. |
| `UPLOAD_RELAY_MAX_CHUNK_BYTES` | `65536` (64 KiB) | Decoded bytes per chunk, not encoded text length. |
| `UPLOAD_RELAY_TTL_MS` | `86400000` (24 hours) | Active expiry from begin and terminal retention duration. |
| `UPLOAD_RELAY_SWEEP_INTERVAL_MS` | `60000` (60 seconds) | Unreferenced periodic sweep interval. |
| `UPLOAD_RELAY_MAX_SESSIONS` | `1024` | All retained session records, including terminal records. |

Numeric environment overrides must contain only decimal digits and resolve to positive safe integers. Session bytes may not exceed global bytes; chunk limit may not exceed 64 MiB; session count may not exceed 100,000; sweep interval may not exceed 2,147,483,647 ms; TTL must fit the implementation's timestamp bound. These are engine validation bounds, **not permission to exceed HTTP admission limits**. Fixed bounds are 65,536 ranges and 8,388,608 bytes (8 MiB) serialized metadata per session. Active reservations charge declared size immediately, not received bytes; sparse/out-of-order writes do not bypass the declared-byte cap. Provision metadata, terminal records, filesystem overhead and free-space headroom in addition to content capacity; 4 GiB is not a whole-volume usage bound.

The unchanged HTTP JSON parser uses its default **100 KiB (102,400 bytes)** body limit. For a decoded chunk of `n` bytes, canonical base64 length is `4 * ceil(n / 3)`. At the default, 65,536 decoded bytes become **87,384 ASCII characters**. A compact JSON-RPC `tools/call` envelope with a 36-character UUID, 43-character resume secret, numeric request ID and a ten-digit offset is **87,629 bytes** (about 88 kB), below that parser cap. This is a synthetic sizing envelope, not an actual upload ID or credential. Extra envelope metadata, whitespace or large IDs also consume body bytes; measure your complete UTF-8 serialized request. Prefer one chunk per request rather than batches.

The separate unchanged **32,768-element** guard counts object members and array entries across the whole parsed body, not characters in strings. That compact chunk envelope has **10 elements**: base64 is one scalar value, not 87,384 elements. A 1 GiB file using full default chunks needs **16,384 ranges**, below the range cap. Very small chunks can exhaust the range cap earlier. Increasing the engine chunk limit does not enlarge the HTTP parser or element guard; HTTP clients must still choose requests below both limits and any proxy's tighter limits. Stdio does not use this HTTP guard.

## Storage, startup and recovery

Durability requires a **persistent, private POSIX volume**, writable by the actual runtime UID, with a dedicated spool root of mode **0700**, private files (0600), no symlink directory chain or multiply linked files, and filesystem support for the used exclusive creation, fsync and atomic rename operations. Do not share the volume with other workloads or run multiple writers/replicas against it. Treat spooled artifact bytes and metadata as private data; hashes alone do not make the spool public-safe.

Imports, help and version do not initialize the spool. Actual stdio/HTTP startup calls an initial sweep without waiting for a relay tool invocation, recovers persisted sessions and starts the unreferenced timer. Startup relay unavailability emits the static `Upload relay unavailable` diagnostic and does not poison existing tools; it does **not** establish relay readiness. Normal shutdown closes the relay and releases ownership after queued work.

Recovery validates private metadata and rehashes stored ranges. Invalid ranges in an open upload are discarded so the client can resend; inconsistent pending-commit content fails closed rather than being silently rewritten. Ownership uses an exclusive `.owner` record. Only a demonstrably dead owner on the same host can be automatically recovered; different-host, live or uncertain ownership fails closed. A restart/container hostname or PID-namespace change can require operator attention. Never blindly delete locks or chmod an unsafe spool to make startup pass. An operator must establish that **no live owner exists** across the relevant hosts/namespaces before any separately authorized lock recovery. Do not print the spool contents into diagnostics.

The implementation uses synchronous filesystem work, startup range rehashing and a serialized provider operation. It has no hard overall provider deadline; blocked provider work can delay all relay operations and cleanup. Byte/session/range/parser bounds are not a whole-service denial-of-service guarantee or protection against malicious same-UID operators. A sweep interval is a target, not a guaranteed maximum deletion latency.

## Operator preflight and rollback plan (not executed here)

Existing Compose is **not altered** for this addition and does not provision the dedicated relay volume. Its credential/token mounts are not a relay durability solution. A later gated deployment must explicitly provision a writable persistent private mount at the selected spool path; do not apply an unapproved Compose change based on this document.

Before any separately approved deployment:

1. Retain the approved current image by immutable identity and record the running service/configuration baseline for rollback. Obtain Coordinator qualification and deployment clearance separately from offline builder work.
2. Resolve the exact Dockerfile, runtime UID/GID, configured spool path and mount destination. Both checked-in Dockerfiles use `USER node` (typically UID 1000 in the Node image); verify the actual image identity rather than assuming it. Compose selects `Dockerfile.propel`.
3. Have the authorized operator provision the dedicated persistent POSIX volume, owned by that runtime UID with root mode 0700, and approve the mount/environment configuration. Verify writable access under the actual runtime identity, persistence across authorized recreation, no symlink chain, private ownership/modes, adequate free space/inodes, and no other writer. Do not widen shared-directory permissions or fetch new credentials to work around failure.
4. Check intended caps against volume capacity and the unchanged HTTP/proxy limits; arrange private client capability custody and content/receipt retention handling. Establish safe lock-owner recovery procedures before restart.
5. Only after clearance, deploy the qualified immutable image with the approved volume/configuration. Inspect static startup diagnostics without recording capability-bearing traffic; separately qualify relay readiness and the authorized eight live Radar tests. No such deploy or live calls are claimed here.

For a separately authorized rollback, quiesce the relay writer, retain its private persistent spool for reconciliation, and restore the retained baseline image and approved baseline configuration. Never run old and new writers against the spool simultaneously. The previous image need not expose relay tools or understand pending sessions; rollback is not upload completion, receipt recovery, remote deletion or remote transaction rollback. Reconcile ambiguous Drive outcomes under separate authority before abandoning sessions or retrying as new uploads.

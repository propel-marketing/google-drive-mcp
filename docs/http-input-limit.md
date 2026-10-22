# MCP HTTP input element budget

## Scope and mechanism

`MAX_MCP_HTTP_INPUT_ELEMENTS = 32_768` is a fixed per-request admission budget
for parsed JSON bodies sent to `POST /mcp`. It mitigates the HTTP input-element
amplification concern in GHSA-46jr-4wx8-v453. SDK 1.32.0's
`maxToolInputElements` belongs to the high-level `McpServer`; this application
constructs low-level `Server`, so upgrading alone did not activate that guard.
The application therefore implements the separately authorized HTTP guard in
`src/http-input-limit.ts`, called at the start of the POST route in `src/index.ts`.
There is no SDK migration, new dependency, tool/schema change, or ingress change.

The guard runs after the existing SDK Express JSON parser, but before session
lookup/timer renewal, `isInitializeRequest`, session/server allocation, SDK
transport validation and tool dispatch. The existing JSON byte limit (default
102,400 bytes) remains unchanged. GET, DELETE and stdio paths are unchanged.

## What counts

Count one element for every own enumerable object member and every array entry,
recursively throughout the entire parsed body. The root container adds no extra
element. A member whose value is another container still counts; its children
also count. Null, booleans and numbers are scalar values. String characters do
not count as separate elements. Empty root objects/arrays count zero.

Examples: `{"a": []}` counts one; `{"a": [null, {"b": "text"}]}` counts four.
All envelopes, tool arguments, metadata, unknown fields, initialization payloads
and batch members share the same request budget. Checking only a recognized
`arguments` field would leave bypasses through other body branches.

Exactly 32,768 elements are admitted by this guard. The 32,769th refuses the
whole request, without partially dispatching batch members. Requests within the
budget still undergo all existing protocol and tool validation; passing this
guard does not make an otherwise invalid request valid.

Refusal is HTTP 413 with the fixed JSON body below (JSON-RPC ID is deliberately
null, not reflected from caller input):

    {"jsonrpc":"2.0","error":{"code":-32600,"message":"MCP HTTP input exceeds 32768 elements"},"id":null}

The response is constant-size and contains no caller ID, method, argument data
or schema-validation diagnostics. Clients must reduce/split an oversized request;
retrying the same body does not change admission.

## Why 32,768

The actual 100-tool catalog has unbounded arrays, including Sheets matrices,
Slides lists and Calendar arrays. Neither those catalog schemas nor the matching
runtime array schemas establish a finite largest legitimate input. Additional
properties are not universally forbidden either. Therefore this cap is an
explicit operational budget, NOT a claimed schema-derived maximum, and it
intentionally refuses some previously schema-valid large inputs over HTTP.

The largest element-dense legitimate capability is bulk Sheets data. A concrete
schema-valid `updateGoogleSheet` input uses `spreadsheetId`, `range`, `data` and
`valueInputOption`. A 1,000-row by 26-column grid of empty-string cells counts
27,004 argument elements / 27,010 total request-body elements. With the fixture's
synthetic identifiers it serializes to 80,192 bytes, below the unchanged parser
limit. This substantial positive workload is preserved and actually executes
against the synthetic Sheets provider in the permanent HTTP test. Another
1,000-by-20 grid of single-character values fits too (21,010 body elements /
82,192 bytes in the measured catalog-analysis fixture); provider live acceptance
is not implied.

For comparison, the largest declared fixed-property shape without arrays is
`addGoogleSheetConditionalFormat`: 16 argument elements / 22 ordinary-envelope
elements. That is not a global input maximum. The bulk-grid case, rather than
small fixed-property calls alone, motivates the chosen budget. String-heavy
inputs remain constrained separately by the byte parser.

The exact boundary is also exercised with the four-argument Sheets shape and
two rows totaling 32,756 empty-string cells: 32,768 body elements. Adding one
cell yields 32,769; both serialized fixtures remain below the JSON byte limit.

## Resource bounds and limitations

Traversal is iterative depth-first, using lazy child iterators rather than
recursive calls, full flattening or `Object.values`/`Object.entries` copies.
It visits at most 32,769 member/array values and stops before descending into
the refused value. Its explicit iterator stack is bounded by the admitted
container edges. Permanent instrumentation-only tests prove early value-read
termination; their proxies/getters are test devices, not admitted HTTP objects.

The helper's precondition is an ordinary body produced by JSON parsing, with
no cycles, getters, proxies or custom prototypes. Parsed own `__proto__` and
shadowed `hasOwnProperty` keys are counted safely. Duplicate JSON keys are
resolved by the parser; this guard counts parsed structure, not raw tokens.
V8 can perform width-dependent internal enumeration setup for `for...in`;
there is no engine-level budget-only allocation guarantee. Parsing,
decompression and engine enumeration costs remain separately bounded only by
the existing parser/runtime behavior. This is not a rate, concurrency, session
count or whole-service denial-of-service guarantee. Deep but under-budget
requests can still reach existing SDK validation. No security residual outside
the authorized element cap is implicitly accepted by this change.

## Regressions and release gate

`test/integration/http-input-limit.test.ts` exercises actual numeric-loopback
HTTP with synthetic Google APIs: over-cap valid Sheets data, exact boundary,
realistic bulk data, unknown metadata, aggregate batch, excessive nesting,
initialization and nonreflection. It asserts fixed refusal and zero existing
session transport/provider dispatch for rejected requests. Initialization also
asserts no new session. The same test bytes were RED before the source fix and
GREEN afterward. `test/http-input-limit.test.ts` permanently tests the counter,
including depth/width boundaries, scalar/null/own-member semantics and early stop.

Qualification uses the recursively discovered explicit permanent-test file list
on Node 20 with `--test-concurrency=1`, preserving the established CLI-startup
contention control. Complete raw TAP/JUnit and the frozen 100-tool catalog plus
16 deterministic response byte comparison are recorded in the managed
`.agents/runs/drive-http-elements` package. The unchanged audit retains four
moderate UUID-chain rows as separately named Coordinator-accepted debt; this is
not a zero-findings release.

This package is repo-only. Deployment is held until the Coordinator separately
qualifies it. No live Google, final image, ingress or production load qualification
is claimed by synthetic regression results.

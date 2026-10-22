import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROJECT_ROOT,
  ProvenanceRedactor,
  REDACTED,
  TEMP_DIR,
  USER_HOME,
} from "../redact-provenance-event.js";
import type {
  ProvenanceActorContext,
  ValidatedProvenanceEvent,
} from "../provenance-schemas.js";

const actorContext: ProvenanceActorContext = {
  source: "main",
  role: "orchestrator",
};

function validatedEvent(
  eventData: unknown,
  overrides: Partial<ValidatedProvenanceEvent> = {},
): ValidatedProvenanceEvent {
  return {
    schemaVersion: 1,
    eventId: "018f46f8-8e70-7abc-8abc-0123456789ab",
    recordedAt: "2026-07-18T12:00:00.000Z",
    harness: "codex",
    eventName: "UserPromptSubmit",
    sessionId: "redaction-session",
    source: "main",
    role: "orchestrator",
    cwd: "C:\\synthetic-project",
    eventData,
    ...overrides,
  };
}

function windowsRedactor(maxFieldBytes = 65_536): ProvenanceRedactor {
  return new ProvenanceRedactor({
    projectRoot: "C:\\synthetic-project",
    userHome: "C:\\Users\\SyntheticUser",
    temporaryDirectory: "C:\\SyntheticTemp",
    maxFieldBytes,
  });
}

test("redacts supported credential families recursively", () => {
  const secrets = [
    "sk-ant-SYNTHETIC_12345678",
    "sk-proj-SYNTHETICVALUE1234567890",
    `ghp_${"A".repeat(24)}`,
    `AKIA${"B".repeat(16)}`,
    `sk_test_${"C".repeat(16)}`,
    "eyJzeW50aGV0aWM.eyJvbmx5IjoidGVzdCJ9.c2lnbmF0dXJl",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETICONLY\n-----END PRIVATE KEY-----",
    "Bearer SYNTHETIC.bearer_token-123",
    "Basic U1lOVEhFVElDOlRFU1Q=",
    "postgresql://synthetic:password@localhost:5432/test",
  ];
  const redacted = windowsRedactor().redact(
    validatedEvent({
      nested: {
        credentials: secrets,
        client_secret: "SYNTHETIC_CLIENT_SECRET",
        command: "SYNTHETIC_PASSWORD=synthetic-password",
      },
    }),
    actorContext,
  );
  const serialized = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("SYNTHETIC_CLIENT_SECRET"), false);
  assert.equal(serialized.includes("synthetic-password"), false);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.ok(redacted.redactionCount >= secrets.length + 2);
});

test("masks sensitive-file tool responses on Windows and POSIX paths", () => {
  const fixtures = [
    {
      redactor: windowsRedactor(),
      path: "C:\\synthetic-project\\.env.local",
      cwd: "C:\\synthetic-project",
    },
    {
      redactor: new ProvenanceRedactor({
        projectRoot: "/opt/synthetic-project",
        userHome: "/Users/SyntheticUser",
        temporaryDirectory: "/tmp/SyntheticTemp",
        maxFieldBytes: 65_536,
      }),
      path: "/Users/SyntheticUser/.ssh/id_ed25519",
      cwd: "/opt/synthetic-project",
    },
  ] as const;

  for (const [index, fixture] of fixtures.entries()) {
    const fixtureSecret = `SYNTHETIC_FILE_SECRET_${index}`;
    const redacted = fixture.redactor.redact(
      validatedEvent(
        {
          tool_name: "Read",
          tool_input: { file_path: fixture.path },
          tool_response: { content: fixtureSecret },
        },
        { eventName: "PostToolUse", toolName: "Read", cwd: fixture.cwd },
      ),
      actorContext,
    );
    const eventData = redacted.eventData as Record<string, unknown>;
    assert.equal(eventData.tool_response, REDACTED);
    assert.equal(JSON.stringify(redacted).includes(fixtureSecret), false);
  }
});

test("tokenizes project home and temporary paths", () => {
  const redacted = windowsRedactor().redact(
    validatedEvent(
      {
        project: "C:\\synthetic-project\\src\\index.ts",
        home: "C:\\Users\\SyntheticUser\\.config\\tool.json",
        temp: "C:\\SyntheticTemp\\capture.tmp",
      },
      {
        cwd: "C:\\synthetic-project\\src",
        transcriptPath: "C:\\Users\\SyntheticUser\\session.jsonl",
      },
    ),
    actorContext,
  );
  const serialized = JSON.stringify(redacted);

  assert.match(serialized, new RegExp(PROJECT_ROOT, "u"));
  assert.match(serialized, new RegExp(USER_HOME, "u"));
  assert.match(serialized, new RegExp(TEMP_DIR, "u"));
  assert.doesNotMatch(serialized, /SyntheticUser|synthetic-project|SyntheticTemp/u);
});

test("records UTF-8 truncation bytes and hashes", () => {
  const original = "🙂".repeat(40);
  const redacted = windowsRedactor(65).redact(
    validatedEvent({ prompt: original }),
    actorContext,
  );
  const eventData = redacted.eventData as { prompt: string };
  const [truncation] = redacted.truncatedFields;

  assert.ok(truncation);
  assert.equal(truncation.path, "eventData.prompt");
  assert.equal(truncation.originalBytes, Buffer.byteLength(original, "utf8"));
  assert.equal(truncation.retainedBytes, Buffer.byteLength(eventData.prompt, "utf8"));
  assert.ok(truncation.retainedBytes <= 65);
  assert.equal(
    truncation.sha256,
    createHash("sha256").update(original, "utf8").digest("hex"),
  );
  assert.equal(eventData.prompt.includes("�"), false);
  assert.match(redacted.contentSha256, /^[a-f0-9]{64}$/u);
});

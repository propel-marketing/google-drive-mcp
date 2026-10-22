import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { IProvenanceJsonlReplayReader } from "./provenance-contracts.js";
import {
  deriveProvenanceJsonlReplayDisposition,
  PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT,
  ValidatedProvenanceJsonlReplaySchema,
  type ProvenanceJsonlReplayIssue,
  type ValidatedProvenanceJsonlReplay,
} from "./provenance-ledger-schemas.js";

export { deriveProvenanceJsonlReplayDisposition };
import {
  RedactedProvenanceEventSchema,
  type RedactedProvenanceEvent,
} from "./provenance-schemas.js";

type AcceptedReplayEvent = {
  event: RedactedProvenanceEvent;
  fingerprint: string;
};

export function createProvenanceReplayEventFingerprint(
  provenanceEvent: RedactedProvenanceEvent,
): string {
  const normalizedEvent = RedactedProvenanceEventSchema.parse(provenanceEvent);
  return createHash("sha256")
    .update(JSON.stringify(normalizedEvent), "utf8")
    .digest("hex");
}

export class ProvenanceJsonlReplayReader
  implements IProvenanceJsonlReplayReader
{
  async read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay> {
    const jsonlFiles = await this.discoverJsonlFiles(jsonlDirectory);
    const acceptedByEventId = new Map<string, AcceptedReplayEvent>();
    const issues: ProvenanceJsonlReplayIssue[] = [];
    let nonBlankLineCount = 0;
    let duplicateEventCount = 0;
    let conflictingEventCount = 0;
    let invalidRecordCount = 0;

    for (const jsonlFile of jsonlFiles) {
      const relativePath = this.safeRelativePath(jsonlDirectory, jsonlFile);
      const lines = (await readFile(jsonlFile, "utf8")).split(/\r?\n/u);
      for (const [lineIndex, line] of lines.entries()) {
        if (line.trim().length === 0) continue;
        nonBlankLineCount += 1;
        const lineNumber = lineIndex + 1;

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(line) as unknown;
        } catch {
          invalidRecordCount += 1;
          retainReplayIssue(issues, {
            relativePath,
            lineNumber,
            disposition: "skipped",
            code: "invalid-json",
            sanitizedMessage: "The JSONL record is not valid JSON.",
          });
          continue;
        }

        const parsedEvent = RedactedProvenanceEventSchema.safeParse(parsedJson);
        if (!parsedEvent.success) {
          invalidRecordCount += 1;
          retainReplayIssue(issues, {
            relativePath,
            lineNumber,
            disposition: "skipped",
            code: "invalid-redacted-event",
            sanitizedMessage:
              "The JSONL record does not match the redacted provenance event schema.",
          });
          continue;
        }

        const fingerprint = createProvenanceReplayEventFingerprint(
          parsedEvent.data,
        );
        const accepted = acceptedByEventId.get(parsedEvent.data.eventId);
        if (accepted === undefined) {
          acceptedByEventId.set(parsedEvent.data.eventId, {
            event: parsedEvent.data,
            fingerprint,
          });
          continue;
        }
        if (accepted.fingerprint === fingerprint) {
          duplicateEventCount += 1;
          continue;
        }

        conflictingEventCount += 1;
        retainReplayIssue(issues, {
          relativePath,
          lineNumber,
          disposition: "blocking",
          code: "conflicting-event-id",
          sanitizedMessage:
            "The event ID is reused by a different redacted provenance event.",
        });
      }
    }

    const events = [...acceptedByEventId.values()]
      .map(({ event }) => event)
      .sort(compareReplayEvents);
    const issueCount = invalidRecordCount + conflictingEventCount;
    return ValidatedProvenanceJsonlReplaySchema.parse({
      jsonlFileCount: jsonlFiles.length,
      nonBlankLineCount,
      validEventCount: events.length,
      duplicateEventCount,
      conflictingEventCount,
      invalidRecordCount,
      disposition: deriveProvenanceJsonlReplayDisposition(
        invalidRecordCount,
        conflictingEventCount,
      ),
      skippedIssueCount: invalidRecordCount,
      blockingIssueCount: conflictingEventCount,
      issueCount,
      issuesShown: issues.length,
      issuesTruncated: issueCount > issues.length,
      issues,
      events,
    });
  }

  private async discoverJsonlFiles(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    const discovered: string[] = [];
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        discovered.push(...(await this.discoverJsonlFiles(entryPath)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        discovered.push(entryPath);
      }
    }
    return discovered.sort((left, right) =>
      compareText(
        this.safeRelativePath(directory, left),
        this.safeRelativePath(directory, right),
      ),
    );
  }

  private safeRelativePath(root: string, filePath: string): string {
    const relativePath = relative(root, filePath)
      .split(sep)
      .map((part) => part.replace(/[\u0000-\u001f\u007f]/gu, "_"))
      .join("/");
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith("../")
    ) {
      throw new Error("Discovered JSONL path is outside the replay directory");
    }
    return relativePath;
  }
}

function retainReplayIssue(
  issues: ProvenanceJsonlReplayIssue[],
  issue: ProvenanceJsonlReplayIssue,
): void {
  if (issues.length < PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT) {
    issues.push(issue);
    return;
  }
  if (
    issue.code !== "conflicting-event-id" ||
    issues.some((retainedIssue) => retainedIssue.code === "conflicting-event-id")
  ) {
    return;
  }
  for (let index = issues.length - 1; index >= 0; index -= 1) {
    if (issues[index]?.disposition === "skipped") {
      issues[index] = issue;
      return;
    }
  }
}

function compareReplayEvents(
  left: RedactedProvenanceEvent,
  right: RedactedProvenanceEvent,
): number {
  return (
    compareText(left.recordedAt, right.recordedAt) ||
    compareText(left.harness, right.harness) ||
    compareText(left.sessionId, right.sessionId) ||
    compareText(left.eventId, right.eventId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

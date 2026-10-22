import process from "node:process";

type HookPayload = {
  tool_name?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  input?: Record<string, unknown>;
};

type AddedCommentLine = {
  filePath: string;
  lineHint: string;
  text: string;
};

const CHECK_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".php",
] as const;

const COMMENT_PREFIX_RE = /^\s*(\/\/|\/\*|\*(?:\s|$)|#(?!\!)|\{\/\*)/;

const POLICY_TEXT =
  "Default to writing no comments. Only add one when the WHY is non-obvious: " +
  "a hidden constraint, a subtle invariant, a workaround for a specific bug, " +
  "behavior that would surprise a reader. If removing the comment would not " +
  "confuse a future reader, do not write it.";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shouldCheck(filePath: string): boolean {
  if (!filePath) {
    return false;
  }
  if (filePath.endsWith("index.ts") || filePath.endsWith("index.tsx")) {
    return false;
  }
  return CHECK_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function extractCommentLines(content: string): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = [];

  content.split(/\r?\n/).forEach((rawLine, index) => {
    if (!COMMENT_PREFIX_RE.test(rawLine)) {
      return;
    }

    const text = rawLine.trim();
    if (text) {
      lines.push({ line: index + 1, text });
    }
  });

  return lines;
}

function addedCommentsFromWrite(filePath: string, content: string): AddedCommentLine[] {
  if (!shouldCheck(filePath)) {
    return [];
  }

  return extractCommentLines(content).map(({ line, text }) => ({
    filePath,
    lineHint: String(line),
    text,
  }));
}

function addedCommentsFromEdit(
  filePath: string,
  oldString: string,
  newString: string,
): AddedCommentLine[] {
  if (!shouldCheck(filePath)) {
    return [];
  }

  const oldCommentTexts = new Set(extractCommentLines(oldString).map(({ text }) => text));
  return extractCommentLines(newString)
    .filter(({ text }) => !oldCommentTexts.has(text))
    .map(({ line, text }) => ({
      filePath,
      lineHint: String(line),
      text,
    }));
}

function filePathFromPatchHeader(line: string): string {
  const match = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/);
  return match?.[1]?.trim() ?? "";
}

function addedCommentsFromPatch(patchText: string): AddedCommentLine[] {
  const added: AddedCommentLine[] = [];
  let currentFilePath = "";
  let addedLineNumber = 0;

  for (const rawLine of patchText.split(/\r?\n/)) {
    const nextFilePath = filePathFromPatchHeader(rawLine);
    if (nextFilePath) {
      currentFilePath = nextFilePath;
      addedLineNumber = 0;
      continue;
    }

    if (!currentFilePath || !shouldCheck(currentFilePath)) {
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      addedLineNumber += 1;
      const addedLine = rawLine.slice(1);
      if (COMMENT_PREFIX_RE.test(addedLine)) {
        added.push({
          filePath: currentFilePath,
          lineHint: `+${addedLineNumber}`,
          text: addedLine.trim(),
        });
      }
      continue;
    }

    if (rawLine.startsWith(" ") || rawLine === "") {
      addedLineNumber += 1;
    }
  }

  return added;
}

function blockWithComments(added: AddedCommentLine[]): never {
  const previewLines = added.slice(0, 20).map((line) => {
    const text = line.text.length > 100 ? `${line.text.slice(0, 100)}...` : line.text;
    return `  ${line.filePath}:${line.lineHint}: ${text}`;
  });

  const message = [
    "[comment-guard] BLOCKED: new source comment(s) detected",
    "",
    `${added.length} new comment line(s):`,
    ...previewLines,
    ...(added.length > 20 ? [`  ... and ${added.length - 20} more`] : []),
    "",
    "Comment policy:",
    POLICY_TEXT,
    "",
    "Rewrite the edit without the comment, or ask the user to temporarily disable this hook with a specific justification.",
    "",
  ].join("\n");

  process.stderr.write(message);
  process.exit(2);
}

async function main(): Promise<void> {
  let payload: HookPayload;

  try {
    payload = JSON.parse(await readStdin()) as HookPayload;
  } catch {
    return;
  }

  const toolName = payload.tool_name ?? payload.tool ?? "";
  const toolInput = payload.tool_input ?? payload.input ?? {};
  let addedComments: AddedCommentLine[] = [];

  if (toolName === "apply_patch") {
    addedComments = addedCommentsFromPatch(asString(toolInput.command));
  } else if (toolName === "Write") {
    addedComments = addedCommentsFromWrite(
      asString(toolInput.file_path),
      asString(toolInput.content),
    );
  } else if (toolName === "Edit") {
    addedComments = addedCommentsFromEdit(
      asString(toolInput.file_path),
      asString(toolInput.old_string),
      asString(toolInput.new_string),
    );
  }

  if (addedComments.length > 0) {
    blockWithComments(addedComments);
  }
}

main().catch(() => {
  process.exit(0);
});

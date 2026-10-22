import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const PLAN_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const RUNS_DIRECTORY = '.agents/runs';

export type RuntimePathErrorCode =
  | 'ROOT_NOT_ABSOLUTE'
  | 'ROOT_MISSING'
  | 'ROOT_NOT_ADW'
  | 'PLAN_NAME_INVALID'
  | 'PLAN_ROOT_OUTSIDE_RUNS';

export class RuntimePathError extends Error {
  readonly code: RuntimePathErrorCode;
  readonly nextAction: string;

  constructor(code: RuntimePathErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = 'RuntimePathError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

const WIN32_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const MSYS_DRIVE_PATTERN = /^\/([A-Za-z])(?:\/(.*))?$/;
const AGENTS_DIRECTORY = '.agents';

function runsOnWin32(): boolean {
  return process.platform === 'win32';
}

function isDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function realpathWhenPresent(resolved: string): string {
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function convertWin32Spelling(candidate: string): string {
  const msysDrive = candidate.match(MSYS_DRIVE_PATTERN);
  const windowsForm = msysDrive ? `${msysDrive[1].toUpperCase()}:\\${msysDrive[2] ?? ''}` : candidate;
  return windowsForm.replace(/\//g, '\\');
}

function isDriveAbsolute(candidate: string): boolean {
  return isAbsolute(candidate) && (!runsOnWin32() || WIN32_DRIVE_ABSOLUTE_PATTERN.test(candidate));
}

export function canonicalizeRootCandidate(candidate: string): string {
  const spelled = runsOnWin32() ? convertWin32Spelling(candidate.trim()) : candidate.trim();
  if (!isDriveAbsolute(spelled)) return spelled;
  return realpathWhenPresent(resolve(spelled).replace(/^[a-z]:/, (drive) => drive.toUpperCase()));
}

export function resolveValidatedProjectRoot(candidate: string = process.env.CODEX_AGENT_ROOT ?? process.cwd()): string {
  const root = canonicalizeRootCandidate(candidate);
  if (!isDriveAbsolute(root)) {
    throw new RuntimePathError(
      'ROOT_NOT_ABSOLUTE',
      `project root "${candidate}" is not an absolute path (drive-relative and relative forms are refused)`,
      'pass the absolute path of the repository checkout, such as <drive>:\\path\\to\\checkout on Windows or /path/to/checkout elsewhere, in CODEX_AGENT_ROOT or run from inside it',
    );
  }
  if (!isDirectory(root)) {
    throw new RuntimePathError(
      'ROOT_MISSING',
      `project root "${root}" is not an existing directory`,
      'pass the absolute path of an existing repository checkout in CODEX_AGENT_ROOT or run from inside it',
    );
  }
  if (!isDirectory(resolve(root, AGENTS_DIRECTORY))) {
    throw new RuntimePathError(
      'ROOT_NOT_ADW',
      `project root "${root}" has no ${AGENTS_DIRECTORY} directory`,
      `pass the repository root that contains ${AGENTS_DIRECTORY}, or run node scripts/init.mjs inside the checkout first`,
    );
  }
  return root;
}

export function assertPlanSlug(value: string, optionName: string): string {
  if (typeof value !== 'string' || !PLAN_SLUG_PATTERN.test(value)) {
    throw new RuntimePathError(
      'PLAN_NAME_INVALID',
      `${optionName} "${String(value)}" does not match ${PLAN_SLUG_PATTERN}`,
      `pass ${optionName} as a lowercase slug of letters, digits, dots, underscores and hyphens that starts with a letter or digit, such as adw-phase1-path-validation`,
    );
  }
  return value;
}

export function assertDateToken(value: string, optionName: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new RuntimePathError(
      'PLAN_NAME_INVALID',
      `${optionName} "${String(value)}" does not match ${DATE_PATTERN}`,
      `pass ${optionName} as a calendar date in YYYY-MM-DD form, such as 2026-10-17`,
    );
  }
  return value;
}

function describeLocationRelativeToRoot(root: string, location: string): string {
  const relativeLocation = relative(realpathWhenPresent(resolve(root)), location);
  if (!relativeLocation) return '.';
  return isAbsolute(relativeLocation) ? relativeLocation : relativeLocation.split(sep).join('/');
}

export function resolvePlanRootWithinRuns(root: string, candidate: string): string {
  const runsRoot = realpathWhenPresent(resolve(root, RUNS_DIRECTORY));
  const planRoot = realpathWhenPresent(resolve(root, candidate.trim()));
  const insideRuns = relative(runsRoot, planRoot);
  if (!insideRuns || insideRuns === '..' || insideRuns.startsWith(`..${sep}`) || isAbsolute(insideRuns)) {
    throw new RuntimePathError(
      'PLAN_ROOT_OUTSIDE_RUNS',
      `plan root "${candidate}" resolves to "${describeLocationRelativeToRoot(root, planRoot)}" relative to the project root, which is not strictly inside "${RUNS_DIRECTORY}"`,
      `pass a plan directory inside ${RUNS_DIRECTORY}, such as ${RUNS_DIRECTORY}/<plan-name>`,
    );
  }
  return planRoot;
}

export function toRegistryOutputDir(root: string, absoluteDir: string): string {
  return relative(root, absoluteDir).split(sep).join('/');
}

export function fromRegistryOutputDir(root: string, stored: string): string {
  return isAbsolute(stored) ? resolve(stored) : resolve(root, stored);
}

function tokenizePaths(text: string, root: string | undefined): string {
  const replacements: Array<[string | undefined, string]> = [
    [root, '<PROJECT_ROOT>'],
    [tmpdir(), '<TEMP_DIR>'],
    [homedir(), '<USER_HOME>'],
  ];
  return replacements.reduce(
    (tokenized, [machinePath, token]) => (machinePath ? tokenized.split(machinePath).join(token) : tokenized),
    text,
  );
}

export function formatRuntimePathError(
  error: RuntimePathError,
  root?: string,
): { error: string; code: RuntimePathErrorCode; nextAction: string } {
  return {
    error: tokenizePaths(error.message, root),
    code: error.code,
    nextAction: tokenizePaths(error.nextAction, root),
  };
}

export function isRuntimePathError(error: unknown): error is RuntimePathError {
  return error instanceof RuntimePathError;
}

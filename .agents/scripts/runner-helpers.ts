import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { fromRegistryOutputDir, resolvePlanRootWithinRuns, resolveValidatedProjectRoot, toRegistryOutputDir } from './runtime-paths';

export interface FileExpected {
  path: string;
  op: 'create' | 'modify' | 'delete';
  required: boolean;
  symbolsRequired?: string[];
  symbolsForbidden?: string[];
}

export interface ManifestTaskRecord {
  taskId: string;
  taskKind: string;
  agentRole: string;
  template: string;
  outputPath?: string;
  artifacts?: FileExpected[];
  completionMarker?: 'jsonl-summary' | 'status-line' | 'exists';
  dependsOn?: string[];
  optional?: boolean;
  wave?: string;
  parentTaskId?: string;
}

export interface SummaryTaskRecord {
  taskId: string;
  status: string;
  assignedTo?: string;
  taskKind?: string;
  blockedBy?: string[];
  parentTaskId?: string | null;
  subject?: string;
  heartbeatAt?: string | null;
}

export type ManagedPlanKind = 'architecture' | 'workflow' | 'task-orchestration' | 'expert';

export interface ActivePlanRecord {
  planName: string;
  outputDir: string;
  kind: ManagedPlanKind;
  mode: string;
  updatedAt: string;
  status?: 'active' | 'paused' | 'completed';
  stopGuard?: boolean;
  runner?: string;
}

export interface ActivePlansRegistry {
  plans: Record<string, ActivePlanRecord>;
}

const RUNTIME_SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TSX_ENTRY_POINT = join('node_modules', 'tsx', 'dist', 'cli.mjs');
const TASKS_SCRIPT = join('.agents', 'scripts', 'tasks.ts');
const ACTIVE_PLANS_REGISTRY = join('.agents', 'active-plans.json');

interface ValidatedProjectRoot {
  candidate: string;
  root: string;
}

let validatedProjectRoot: ValidatedProjectRoot | undefined;

export function projectRoot(): string {
  const candidate = process.env.CODEX_AGENT_ROOT ?? process.cwd();
  if (validatedProjectRoot?.candidate !== candidate) {
    validatedProjectRoot = { candidate, root: resolveValidatedProjectRoot(candidate) };
  }
  return validatedProjectRoot.root;
}

export function resolvePlanRoot(candidate: string): string {
  return resolvePlanRootWithinRuns(projectRoot(), candidate);
}

export function normalizePath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot(), path);
}

function firstExistingPath(sibling: string, fallback: string): string {
  return existsSync(sibling) ? sibling : fallback;
}

function tsxEntryPoint(): string {
  return firstExistingPath(resolve(RUNTIME_SCRIPTS_DIR, '..', '..', TSX_ENTRY_POINT), join(projectRoot(), TSX_ENTRY_POINT));
}

function tasksScriptPath(): string {
  return firstExistingPath(join(RUNTIME_SCRIPTS_DIR, 'tasks.ts'), join(projectRoot(), TASKS_SCRIPT));
}

export function runLocalJson(args: string[]): unknown {
  const root = projectRoot();
  const tasksCli = spawnSync(process.execPath, [tsxEntryPoint(), tasksScriptPath(), ...args], {
    cwd: root,
    env: { ...process.env, CODEX_AGENT_ROOT: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tasksCli.status !== 0) {
    const failureDetail = tasksCli.error?.message ?? tasksCli.stderr.trim();
    throw new Error(`[runner-helpers.runLocalJson] tasks.ts ${args.join(' ')} exited ${tasksCli.status}: ${failureDetail}`);
  }
  return JSON.parse(tasksCli.stdout);
}

export function deleteIfExists(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function activePlansRegistryPath(): string {
  return join(projectRoot(), ACTIVE_PLANS_REGISTRY);
}

function mapRegistryOutputDirs(
  plans: Record<string, ActivePlanRecord>,
  convertOutputDir: (root: string, outputDir: string) => string,
): Record<string, ActivePlanRecord> {
  const root = projectRoot();
  return Object.fromEntries(
    Object.entries(plans).map(([planName, record]) => [planName, { ...record, outputDir: convertOutputDir(root, record.outputDir) }]),
  );
}

export function loadActivePlansRegistry(): ActivePlansRegistry {
  const path = activePlansRegistryPath();
  if (!existsSync(path)) return { plans: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActivePlansRegistry>;
    return { plans: mapRegistryOutputDirs(parsed.plans ?? {}, fromRegistryOutputDir) };
  } catch {
    return { plans: {} };
  }
}

export function writeActivePlansRegistry(registry: ActivePlansRegistry): void {
  const path = activePlansRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ plans: mapRegistryOutputDirs(registry.plans, toRegistryOutputDir) }, null, 2));
}

export function upsertActivePlan(record: ActivePlanRecord): void {
  const registry = loadActivePlansRegistry();
  registry.plans[record.planName] = record;
  writeActivePlansRegistry(registry);
}

export function removeActivePlan(planName: string): void {
  const registry = loadActivePlansRegistry();
  if (!(planName in registry.plans)) return;
  delete registry.plans[planName];
  writeActivePlansRegistry(registry);
}

export function listActivePlans(kind?: ManagedPlanKind): ActivePlanRecord[] {
  const plans = Object.values(loadActivePlansRegistry().plans);
  return kind ? plans.filter((plan) => plan.kind === kind) : plans;
}

export function resolveActivePlan(kind: ManagedPlanKind, requestedPlanName?: string): ActivePlanRecord | null {
  const plans = listActivePlans(kind);
  if (requestedPlanName) return plans.find((plan) => plan.planName === requestedPlanName) ?? null;
  if (plans.length === 1) return plans[0]!;
  return null;
}

export function loadJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function fileExists(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
}

export function fileHasMarker(path: string, marker: ManifestTaskRecord['completionMarker'] = 'exists'): boolean {
  if (!existsSync(path)) return false;
  if (marker === 'exists') return fileExists(path);
  const content = readFileSync(path, 'utf8').trimEnd();
  if (!content) return false;
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (marker === 'status-line') {
    return (lines.at(-1) ?? '').trim() === 'Status: COMPLETE';
  }
  const candidate = [...lines].reverse().find((line) => line.trim().startsWith('{'));
  if (!candidate) return false;
  try {
    const parsed = JSON.parse(candidate) as { _summary?: boolean; status?: string };
    return parsed._summary === true && parsed.status === 'complete';
  } catch {
    return false;
  }
}

export function summaryTasks(planName: string): SummaryTaskRecord[] {
  try {
    const summary = runLocalJson(['summary', '--plan', planName]) as { tasks?: SummaryTaskRecord[] };
    return summary.tasks ?? [];
  } catch {
    return [];
  }
}

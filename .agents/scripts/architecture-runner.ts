#!/usr/bin/env tsx
import { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { deleteIfExists, fileHasMarker, loadJsonFile, normalizePath, projectRoot, resolveActivePlan, resolvePlanRoot, runLocalJson, summaryTasks, upsertActivePlan } from './runner-helpers';
import { assertDateToken, assertPlanSlug, DATE_PATTERN, formatRuntimePathError, isRuntimePathError } from './runtime-paths';

type PhaseName = 'inventory' | 'diagnose' | 'plan' | 'issues' | 'spec';
type Mode = 'inventory' | 'audit' | 'spec' | 'expert';

type ManifestTask = {
  taskId: string;
  template: string;
  outputPath: string;
  wave: string;
  dependsOn?: string[];
  completionMarker?: 'jsonl-summary' | 'status-line' | 'exists';
  agentRole?: string;
};

type ManifestPhase = {
  name: PhaseName;
  taskKind: string;
  agentRole: string;
  completionMarker?: 'jsonl-summary' | 'status-line' | 'exists';
  tasks: ManifestTask[];
};

type ArchitectureManifest = {
  kind: 'architecture';
  phases: ManifestPhase[];
};

type WaveLedgerEntry = {
  taskId: string;
  phase: PhaseName;
  wave: string;
  agentRole: string;
  template: string;
  outputPath: string;
  briefHash: string | null;
  threadId: string | null;
  attempt: number;
  status: 'pending' | 'dispatched' | 'completed' | 'failed';
  artifactStatus: 'missing' | 'complete' | 'incomplete';
  spawnedAt: string | null;
  completedAt: string | null;
  closureStatus?: 'pending' | 'closed';
};

type ResolvedTask = ManifestTask & {
  phase: PhaseName;
  taskKind: string;
  agentRole: string;
  completionMarker: 'jsonl-summary' | 'status-line' | 'exists';
  dependsOn: string[];
};

const DEFAULT_ARCHITECTURE_ROOT = join('.agents', 'runs', 'architecture');
const MANIFEST_PATH = join('.agents', 'contracts', 'architecture.manifest.json');
const LEGACY_ACTIVE_PLAN_MARKER = join('.agents', 'active-architecture-plan.json');
const LEGACY_ACTIVE_MANAGED_PLAN_MARKER = join('.agents', 'active-managed-plan.json');

function loadManifest(): ArchitectureManifest {
  return loadJsonFile<ArchitectureManifest>(normalizePath(MANIFEST_PATH));
}

function architectureRoot(root = projectRoot()): string {
  return join(root, DEFAULT_ARCHITECTURE_ROOT);
}

function latestRun(root = projectRoot()): string | null {
  const runsDir = architectureRoot(root);
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return runs.length ? join(runsDir, runs[runs.length - 1]!) : null;
}

function ensureRunDirectories(outputDir: string): void {
  for (const phase of ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[]) {
    mkdirSync(join(outputDir, phase), { recursive: true });
  }
}

function defaultPlanName(outputDir: string): string {
  return `architecture-${basename(outputDir)}`;
}

function ledgerPath(outputDir: string): string {
  return join(outputDir, 'architecture-wave-ledger.json');
}

function readLedger(outputDir: string): WaveLedgerEntry[] {
  const path = ledgerPath(outputDir);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as WaveLedgerEntry[];
}

function writeLedger(outputDir: string, entries: WaveLedgerEntry[]): void {
  writeFileSync(ledgerPath(outputDir), JSON.stringify(entries, null, 2));
}

function orchestratorDir(outputDir: string): string {
  return join(outputDir, 'orchestrator');
}

function writeOrchestratorJson(outputDir: string, name: string, payload: object): void {
  const targetDir = orchestratorDir(outputDir);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, name), `${JSON.stringify(payload, null, 2)}\n`);
}

function resolveArchitectureOutputDir(options: { outputDir?: string; latest?: boolean }): string {
  const outputDir = options.outputDir ?? (options.latest ? latestRun() : null);
  if (!outputDir) {
    console.error('No architecture output directory provided and no latest run found.');
    process.exit(1);
  }
  return resolvePlanRoot(outputDir);
}

function resolveArchitectureRunsRoot(options: { architectureRoot?: string; root?: string }): string {
  return resolvePlanRoot(options.root ?? options.architectureRoot ?? DEFAULT_ARCHITECTURE_ROOT);
}

function manifestTasksForMode(manifest: ArchitectureManifest, mode: Mode): ResolvedTask[] {
  const phases = manifest.phases.filter((phase) => {
    if (mode === 'inventory') return phase.name === 'inventory';
    if (mode === 'spec') return true;
    return phase.name !== 'spec';
  });
  const byPhase = new Map<PhaseName, ResolvedTask[]>();
  for (const phase of phases) {
    const resolved = phase.tasks.map((task) => ({
      ...task,
      phase: phase.name,
      taskKind: phase.taskKind,
      agentRole: task.agentRole ?? phase.agentRole,
      completionMarker: task.completionMarker ?? phase.completionMarker ?? 'exists',
      dependsOn: [...(task.dependsOn ?? [])],
    }));
    byPhase.set(phase.name, resolved);
  }
  const ordered = ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[];
  for (let index = 0; index < ordered.length; index += 1) {
    const phase = ordered[index]!;
    const current = byPhase.get(phase);
    if (!current) continue;
    const priorTaskIds = ordered.slice(0, index).flatMap((prior) => byPhase.get(prior)?.map((task) => task.taskId) ?? []);
    for (const task of current) {
      task.dependsOn = [...new Set([...priorTaskIds, ...task.dependsOn])];
    }
  }
  return ordered.flatMap((phase) => byPhase.get(phase) ?? []);
}

function createTaskIfMissing(planName: string, outputDir: string, task: ResolvedTask, existingTaskIds: Set<string>): void {
  if (existingTaskIds.has(task.taskId)) {
    runLocalJson([
      'update',
      '--plan', planName,
      '--task-id', task.taskId,
      '--owner', task.agentRole,
      '--task-kind', task.taskKind,
      '--caller', 'planner',
    ]);
    return;
  }
  const args = [
    'create',
    '--plan', planName,
    '--task-id', task.taskId,
    '--subject', `Architecture ${task.phase}: ${task.taskId.split(':')[1]}`,
    '--active-form', `Architecture ${task.phase}: ${task.taskId.split(':')[1]}`,
    '--assigned-to', task.agentRole,
    '--layer', 'audit',
    '--codebase', projectRoot(),
    '--template', `architecture/${task.template}`,
    '--task-kind', task.taskKind,
    '--files-expected', JSON.stringify({ path: join(outputDir, task.outputPath), op: 'create', required: true }),
  ];
  if (task.dependsOn.length) args.push('--depends-on', ...task.dependsOn);
  runLocalJson(args);
  existingTaskIds.add(task.taskId);
}

function artifactComplete(outputDir: string, task: ResolvedTask): boolean {
  return fileHasMarker(join(outputDir, task.outputPath), task.completionMarker);
}

function reconcileTask(planName: string, outputDir: string, task: ResolvedTask, completedTaskIds: Set<string>): boolean {
  if (completedTaskIds.has(task.taskId)) return false;
  const target = join(outputDir, task.outputPath);
  if (!artifactComplete(outputDir, task)) return false;
  runLocalJson(['log-mutation', '--plan', planName, '--task-id', task.taskId, '--path', target]);
  runLocalJson([
    'complete',
    '--plan', planName,
    '--task-id', task.taskId,
    '--caller', 'builder',
    '--discovered-context', '{"driftFromTDD":[],"filesCreated":[],"filesModified":[],"decisionsNotInTDD":[]}',
    '--self-audit', '{"assumptions":"none","shortcuts":"none","patternAlignment":"aligned"}',
  ]);
  completedTaskIds.add(task.taskId);
  return true;
}

function taskById(tasks: ResolvedTask[], taskId: string): ResolvedTask | undefined {
  return tasks.find((task) => task.taskId === taskId);
}

function nextWaveState(planName: string, outputDir: string, tasks: ResolvedTask[]): {
  nextPhase: PhaseName | 'complete';
  runnableTaskIds: string[];
  waves: string[];
} {
  const summary = runLocalJson(['summary', '--plan', planName]) as { runnableTaskIds?: string[] };
  const runnable = new Set(summary.runnableTaskIds ?? []);
  for (const phase of ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[]) {
    const phaseTasks = tasks.filter((task) => task.phase === phase);
    if (!phaseTasks.length) continue;
    const completed = phaseTasks.every((task) => artifactComplete(outputDir, task));
    if (completed) continue;
    return {
      nextPhase: phase,
      runnableTaskIds: phaseTasks.filter((task) => runnable.has(task.taskId)).map((task) => task.taskId),
      waves: [...new Set(phaseTasks.map((task) => task.wave))],
    };
  }
  return { nextPhase: 'complete', runnableTaskIds: [], waves: [] };
}

function phaseCompletionSummary(outputDir: string, tasks: ResolvedTask[]) {
  const phases = ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[];
  return Object.fromEntries(phases.map((phase) => [phase, phaseStatus(outputDir, tasks, phase)]));
}

function cleanupCandidates(entries: WaveLedgerEntry[]): Array<{ taskId: string; threadId: string; phase: PhaseName; wave: string }> {
  return entries
    .filter((entry) => entry.status === 'completed')
    .filter((entry) => entry.closureStatus !== 'closed')
    .filter((entry): entry is WaveLedgerEntry & { threadId: string } => typeof entry.threadId === 'string' && entry.threadId.length > 0)
    .map((entry) => ({
      taskId: entry.taskId,
      threadId: entry.threadId,
      phase: entry.phase,
      wave: entry.wave,
    }));
}

function markPlanCompleted(planName: string, outputDir: string, mode: Mode): void {
  upsertActivePlan({
    planName,
    outputDir,
    kind: 'architecture',
    mode,
    status: 'completed',
    stopGuard: false,
    runner: 'architecture-runner',
    updatedAt: new Date().toISOString(),
  });
}

function seedLedger(outputDir: string, tasks: ResolvedTask[]): WaveLedgerEntry[] {
  const current = new Map(readLedger(outputDir).map((entry) => [entry.taskId, entry]));
  const entries = tasks.map<WaveLedgerEntry>((task) => current.get(task.taskId) ?? ({
    taskId: task.taskId,
    phase: task.phase,
    wave: task.wave,
    agentRole: task.agentRole,
    template: task.template,
    outputPath: task.outputPath,
    briefHash: null,
    threadId: null,
    attempt: 0,
    status: 'pending',
    artifactStatus: 'missing',
    spawnedAt: null,
    completedAt: null,
    closureStatus: 'closed',
  }));
  writeLedger(outputDir, entries);
  return entries;
}

function updateLedger(outputDir: string, taskId: string, mutate: (entry: WaveLedgerEntry) => void): WaveLedgerEntry[] {
  const entries = readLedger(outputDir);
  const entry = entries.find((candidate) => candidate.taskId === taskId);
  if (!entry) {
    console.error(`Ledger entry missing for ${taskId}`);
    process.exit(1);
  }
  mutate(entry);
  writeLedger(outputDir, entries);
  return entries;
}

function phaseStatus(outputDir: string, tasks: ResolvedTask[], phase: PhaseName) {
  const phaseTasks = tasks.filter((task) => task.phase === phase);
  const missing = phaseTasks.filter((task) => !existsSync(join(outputDir, task.outputPath))).map((task) => task.outputPath);
  const incomplete = phaseTasks.filter((task) => existsSync(join(outputDir, task.outputPath)) && !artifactComplete(outputDir, task)).map((task) => task.outputPath);
  return {
    expected: phaseTasks.length,
    present: phaseTasks.length - missing.length,
    complete: phaseTasks.length - missing.length - incomplete.length,
    missing,
    incomplete,
  };
}

function validateManifest(manifest: ArchitectureManifest): string[] {
  const taskIds = new Set<string>();
  const errors: string[] = [];
  const tasks = manifest.phases.flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, task })));
  for (const { task } of tasks) {
    if (taskIds.has(task.taskId)) errors.push(`Duplicate taskId: ${task.taskId}`);
    taskIds.add(task.taskId);
  }
  for (const { task } of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) errors.push(`Unknown dependency '${dependency}' in ${task.taskId}`);
    }
  }
  return errors;
}

function writeMarkers(planName: string, outputDir: string, mode: Mode): void {
  upsertActivePlan({
    planName,
    outputDir,
    kind: 'architecture',
    mode,
    status: 'active',
    stopGuard: false,
    runner: 'architecture-runner',
    updatedAt: new Date().toISOString(),
  });
  deleteIfExists(join(projectRoot(), LEGACY_ACTIVE_PLAN_MARKER));
  deleteIfExists(join(projectRoot(), LEGACY_ACTIVE_MANAGED_PLAN_MARKER));
}

function resolveRegistryPlan(options: { outputDir?: string; latest?: boolean; planName?: string }): { planName: string; outputDir: string } | null {
  const active = resolveActivePlan('architecture', options.planName);
  if (active) return { planName: active.planName, outputDir: active.outputDir };
  return null;
}

const program = new Command();
program.name('architecture-runner');

program.hook('preAction', (_thisCommand, actionCommand) => {
  const planName = actionCommand.opts().planName as string | undefined;
  if (planName !== undefined) assertPlanSlug(planName, '--plan-name');
});

program
  .command('init')
  .requiredOption('--date <yyyy-mm-dd>', `run date matching ${DATE_PATTERN}`)
  .requiredOption('--feature-slug <slug>')
  .option('--architecture-root <path>', 'directory under .agents/runs that holds architecture runs', DEFAULT_ARCHITECTURE_ROOT)
  .option('--root <path>', 'deprecated alias of --architecture-root')
  .action((options: { date: string; featureSlug: string; architectureRoot: string; root?: string }) => {
    const runsRoot = resolveArchitectureRunsRoot(options);
    const outputDir = join(runsRoot, `${assertDateToken(options.date, '--date')}-${assertPlanSlug(options.featureSlug, '--feature-slug')}`);
    ensureRunDirectories(outputDir);
    console.log(JSON.stringify({ created: true, outputDir }, null, 2));
  });

program
  .command('validate-manifest')
  .action(() => {
    const manifest = loadManifest();
    const errors = validateManifest(manifest);
    console.log(JSON.stringify({ success: errors.length === 0, errors }, null, 2));
    if (errors.length) process.exit(1);
  });

program
  .command('materialize')
  .requiredOption('--output-dir <path>')
  .option('--plan-name <name>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { outputDir: string; planName?: string; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const planName = assertPlanSlug(options.planName ?? defaultPlanName(outputDir), '--plan-name');
    ensureRunDirectories(outputDir);
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const existing = summaryTasks(planName);
    const existingTaskIds = new Set(existing.map((row) => row.taskId));
    const completedTaskIds = new Set(existing.filter((row) => row.status === 'completed').map((row) => row.taskId));
    let reconciled = 0;
    for (const task of tasks) {
      createTaskIfMissing(planName, outputDir, task, existingTaskIds);
      if (reconcileTask(planName, outputDir, task, completedTaskIds)) reconciled += 1;
    }
    seedLedger(outputDir, tasks);
    writeMarkers(planName, outputDir, options.mode);
    console.log(JSON.stringify({ success: true, planName, mode: options.mode, outputDir, tasksCreatedOrVerified: tasks.length, reconciledCompletedTasks: reconciled }, null, 2));
  });

program
  .command('reconcile')
  .requiredOption('--output-dir <path>')
  .requiredOption('--plan-name <name>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { outputDir: string; planName: string; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const completedTaskIds = new Set(summaryTasks(options.planName).filter((row) => row.status === 'completed').map((row) => row.taskId));
    let reconciled = 0;
    for (const task of tasks) {
      if (reconcileTask(options.planName, outputDir, task, completedTaskIds)) reconciled += 1;
    }
    console.log(JSON.stringify({ success: true, planName: options.planName, outputDir, reconciledCompletedTasks: reconciled }, null, 2));
  });

program
  .command('dispatch-plan')
  .requiredOption('--plan-name <name>')
  .requiredOption('--output-dir <path>')
  .requiredOption('--phase <phase>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { planName: string; outputDir: string; phase: PhaseName; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const tasks = manifestTasksForMode(loadManifest(), options.mode).filter((task) => task.phase === options.phase);
    const summary = runLocalJson(['summary', '--plan', options.planName]) as { tasks?: Array<{ taskId: string; status: string }> };
    const statuses = new Map((summary.tasks ?? []).map((task) => [task.taskId, task.status]));
    const completed = new Set([...statuses.entries()].filter(([, status]) => status === 'completed').map(([taskId]) => taskId));
    const jobs = tasks
      .filter((task) => statuses.get(task.taskId) !== 'completed')
      .filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
      .map((task) => ({
        taskId: task.taskId,
        agentType: task.agentRole,
        briefPath: join(projectRoot(), '.agents', 'skills', 'architecture', 'templates', task.template),
        expectedOutput: join(outputDir, task.outputPath),
        dependsOn: task.dependsOn,
        retryable: true,
        wave: task.wave,
      }));
    console.log(JSON.stringify({ success: true, planName: options.planName, phase: options.phase, jobs }, null, 2));
  });

program
  .command('record-dispatch')
  .requiredOption('--output-dir <path>')
  .requiredOption('--task-id <id>')
  .requiredOption('--thread-id <id>')
  .option('--brief-hash <hash>')
  .action((options: { outputDir: string; taskId: string; threadId: string; briefHash?: string }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const entries = updateLedger(outputDir, options.taskId, (entry) => {
      entry.threadId = options.threadId;
      entry.briefHash = options.briefHash ?? entry.briefHash;
      entry.attempt += 1;
      entry.status = 'dispatched';
      entry.spawnedAt = new Date().toISOString();
      entry.closureStatus = 'pending';
    });
    console.log(JSON.stringify({ success: true, entry: entries.find((entry) => entry.taskId === options.taskId) }, null, 2));
  });

program
  .command('record-result')
  .requiredOption('--output-dir <path>')
  .requiredOption('--task-id <id>')
  .requiredOption('--status <status>')
  .action((options: { outputDir: string; taskId: string; status: 'completed' | 'failed' | 'pending' }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const entries = updateLedger(outputDir, options.taskId, (entry) => {
      entry.status = options.status === 'pending' ? 'pending' : options.status;
      if (options.status === 'completed') entry.completedAt = new Date().toISOString();
      if (options.status === 'pending') entry.closureStatus = entry.threadId ? 'pending' : 'closed';
    });
    console.log(JSON.stringify({ success: true, entry: entries.find((entry) => entry.taskId === options.taskId) }, null, 2));
  });

program
  .command('mark-closed')
  .requiredOption('--output-dir <path>')
  .requiredOption('--task-id <id>')
  .action((options: { outputDir: string; taskId: string }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const entries = updateLedger(outputDir, options.taskId, (entry) => {
      entry.closureStatus = 'closed';
    });
    console.log(JSON.stringify({ success: true, entry: entries.find((entry) => entry.taskId === options.taskId) }, null, 2));
  });

program
  .command('reconcile-wave')
  .requiredOption('--plan-name <name>')
  .requiredOption('--output-dir <path>')
  .requiredOption('--phase <phase>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { planName: string; outputDir: string; phase: PhaseName; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const tasks = manifestTasksForMode(loadManifest(), options.mode).filter((task) => task.phase === options.phase);
    const completedTaskIds = new Set(summaryTasks(options.planName).filter((row) => row.status === 'completed').map((row) => row.taskId));
    let reconciled = 0;
    for (const task of tasks) {
      const artifactStatus = artifactComplete(outputDir, task) ? 'complete' : existsSync(join(outputDir, task.outputPath)) ? 'incomplete' : 'missing';
      updateLedger(outputDir, task.taskId, (entry) => {
        entry.artifactStatus = artifactStatus;
        if (artifactStatus === 'complete') {
          entry.status = 'completed';
          entry.completedAt = entry.completedAt ?? new Date().toISOString();
        }
      });
      if (reconcileTask(options.planName, outputDir, task, completedTaskIds)) reconciled += 1;
    }
    console.log(JSON.stringify({ success: true, planName: options.planName, phase: options.phase, reconciledCompletedTasks: reconciled, ledgerPath: ledgerPath(outputDir) }, null, 2));
  });

program
  .command('next-wave')
  .requiredOption('--plan-name <name>')
  .requiredOption('--output-dir <path>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { planName: string; outputDir: string; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const summary = runLocalJson(['summary', '--plan', options.planName]) as { runnableTaskIds?: string[] };
    const runnable = new Set(summary.runnableTaskIds ?? []);
    for (const phase of ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[]) {
      const phaseTasks = tasks.filter((task) => task.phase === phase);
      if (!phaseTasks.length) continue;
      const completed = phaseTasks.every((task) => artifactComplete(outputDir, task));
      if (completed) continue;
      console.log(JSON.stringify({
        success: true,
        nextPhase: phase,
        runnableTaskIds: phaseTasks.filter((task) => runnable.has(task.taskId)).map((task) => task.taskId),
        waves: [...new Set(phaseTasks.map((task) => task.wave))],
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({ success: true, nextPhase: 'complete', runnableTaskIds: [], waves: [] }, null, 2));
  });

program
  .command('consume-completion')
  .requiredOption('--plan-name <name>')
  .requiredOption('--output-dir <path>')
  .requiredOption('--task-id <id>')
  .option('--thread-id <id>')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { planName: string; outputDir: string; taskId: string; threadId?: string; mode: Mode }) => {
    const outputDir = resolveArchitectureOutputDir(options);
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const task = taskById(tasks, options.taskId);
    if (!task) {
      console.error(JSON.stringify({ success: false, error: `Unknown task '${options.taskId}' for architecture manifest.` }, null, 2));
      process.exit(1);
    }

    const completedTaskIds = new Set(summaryTasks(options.planName).filter((row) => row.status === 'completed').map((row) => row.taskId));
    const reconciled = reconcileTask(options.planName, outputDir, task, completedTaskIds);
    const artifactStatus = artifactComplete(outputDir, task) ? 'complete' : existsSync(join(outputDir, task.outputPath)) ? 'incomplete' : 'missing';
    const entries = updateLedger(outputDir, task.taskId, (entry) => {
      entry.threadId = options.threadId ?? entry.threadId;
      entry.artifactStatus = artifactStatus;
      if (artifactStatus === 'complete') {
        entry.status = 'completed';
        entry.completedAt = entry.completedAt ?? new Date().toISOString();
      }
      entry.closureStatus = entry.threadId ? 'pending' : 'closed';
    });

    const next = nextWaveState(options.planName, outputDir, tasks);
    const phases = phaseCompletionSummary(outputDir, tasks);
    const cleanup = cleanupCandidates(entries);
    const state = {
      success: true,
      planName: options.planName,
      outputDir,
      taskId: task.taskId,
      taskPhase: task.phase,
      reconciledCompletedTask: reconciled,
      ledgerEntry: entries.find((entry) => entry.taskId === task.taskId) ?? null,
      nextAction: next.nextPhase === 'complete'
        ? { type: 'plan_complete' as const, phase: 'complete', runnableTaskIds: [], waves: [] }
        : { type: 'dispatch_next_wave' as const, phase: next.nextPhase, runnableTaskIds: next.runnableTaskIds, waves: next.waves },
      cleanupAction: cleanup.length
        ? { type: 'close_completed_agents' as const, candidates: cleanup }
        : { type: 'none' as const, candidates: [] },
      phases,
      summary: runLocalJson(['summary', '--plan', options.planName]),
      generatedAt: new Date().toISOString(),
    };

    writeOrchestratorJson(outputDir, 'next-action.json', state);
    if (next.nextPhase === 'complete') {
      markPlanCompleted(options.planName, outputDir, options.mode);
      writeOrchestratorJson(outputDir, 'plan-complete.json', state);
    }

    console.log(JSON.stringify(state, null, 2));
  });

program
  .command('status')
  .option('--output-dir <path>')
  .option('--plan-name <name>')
  .option('--latest', 'Use the latest architecture run under .agents/runs/architecture')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { outputDir?: string; planName?: string; latest?: boolean; mode: Mode }) => {
    const active = !options.outputDir && !options.latest ? resolveRegistryPlan(options) : null;
    const outputDir = resolveArchitectureOutputDir({ outputDir: active?.outputDir ?? options.outputDir, latest: options.latest });
    const planName = options.planName ?? active?.planName;
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const phases = ['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[];
    console.log(JSON.stringify({
      outputDir,
      planName,
      status: Object.fromEntries(phases.map((phase) => [phase, phaseStatus(outputDir, tasks, phase)])),
      summary: planName ? runLocalJson(['summary', '--plan', planName]) : null,
      ledgerPath: ledgerPath(outputDir),
    }, null, 2));
  });

program
  .command('resume-plan')
  .option('--output-dir <path>')
  .option('--plan-name <name>')
  .option('--latest', 'Use the latest architecture run under .agents/runs/architecture')
  .option('--mode <mode>', 'inventory|audit|spec|expert', 'audit')
  .action((options: { outputDir?: string; planName?: string; latest?: boolean; mode: Mode }) => {
    const active = !options.outputDir && !options.latest ? resolveRegistryPlan(options) : null;
    const outputDir = resolveArchitectureOutputDir({ outputDir: active?.outputDir ?? options.outputDir, latest: options.latest });
    const planName = assertPlanSlug(options.planName ?? active?.planName ?? defaultPlanName(outputDir), '--plan-name');
    const tasks = manifestTasksForMode(loadManifest(), options.mode);
    const phaseSummaries = (['inventory', 'diagnose', 'plan', 'issues', 'spec'] as PhaseName[]).map((phase) => ({ phase, ...phaseStatus(outputDir, tasks, phase) }));
    const firstIncompletePhase = phaseSummaries.find((phase) => phase.complete < phase.expected)?.phase ?? 'complete';
    console.log(JSON.stringify({
      outputDir,
      planName,
      firstIncompletePhase,
      summary: runLocalJson(['summary', '--plan', planName]),
      ledger: readLedger(outputDir),
      phases: phaseSummaries,
    }, null, 2));
  });

program
  .command('list-runs')
  .option('--architecture-root <path>', 'directory under .agents/runs that holds architecture runs', DEFAULT_ARCHITECTURE_ROOT)
  .option('--root <path>', 'deprecated alias of --architecture-root')
  .action((options: { architectureRoot: string; root?: string }) => {
    const root = resolveArchitectureRunsRoot(options);
    if (!existsSync(root)) {
      console.log(JSON.stringify({ runs: [] }, null, 2));
      return;
    }
    const runs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(root, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
    console.log(JSON.stringify({ runs }, null, 2));
  });

function parseGuardingRuntimePaths(): void {
  try {
    program.parse(process.argv);
  } catch (error) {
    if (!isRuntimePathError(error)) throw error;
    console.error(JSON.stringify(formatRuntimePathError(error), null, 2));
    process.exit(1);
  }
}

parseGuardingRuntimePaths();

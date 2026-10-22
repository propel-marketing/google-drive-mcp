#!/usr/bin/env tsx
import { Command } from 'commander';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { deleteIfExists, fileExists, loadJsonFile, normalizePath, projectRoot, resolvePlanRoot, runLocalJson, summaryTasks, upsertActivePlan } from './runner-helpers';
import { assertPlanSlug, formatRuntimePathError, isRuntimePathError } from './runtime-paths';

type Artifact = { path: string; op: 'create' | 'modify' | 'delete'; required: boolean };
type Stage = {
  name: 'convert-to-spec' | 'convert-to-tasks' | 'plan-markdown' | 'final-triage' | 'execute';
  taskId: string;
  taskKind: string;
  agentRole: string;
  template: string;
  dependsOn?: string[];
  parentTaskId?: string;
  artifacts: Artifact[];
};

type Manifest = {
  kind: 'task-orchestration';
  stages: Stage[];
};

const LEGACY_ACTIVE_MARKER = join('.agents', 'active-managed-plan.json');
const MANIFEST_PATH = join('.agents', 'contracts', 'task-orchestration.manifest.json');
const EXECUTE_TASK_ID = 'task-orchestration:execute';
const FINAL_TRIAGE_REPORT = join('agent-outputs', 'planner', 'final-triage-report.md');

function loadManifest(): Manifest {
  return loadJsonFile<Manifest>(normalizePath(MANIFEST_PATH));
}

function resolveArtifacts(planName: string, planRoot: string, stage: Stage): Artifact[] {
  return stage.artifacts.map((artifact) => ({
    ...artifact,
    path: join(planRoot, artifact.path.replace('{PLAN_NAME}', planName)),
  }));
}

function createTaskIfMissing(planName: string, planRoot: string, stage: Stage, existingTaskIds: Set<string>): void {
  if (existingTaskIds.has(stage.taskId)) {
    const args = [
      'update',
      '--plan', planName,
      '--task-id', stage.taskId,
      '--owner', stage.agentRole,
      '--task-kind', stage.taskKind,
      '--caller', 'planner',
    ];
    if (stage.parentTaskId) args.push('--parent-task-id', stage.parentTaskId);
    runLocalJson(args);
    return;
  }
  const args = [
    'create',
    '--plan', planName,
    '--task-id', stage.taskId,
    '--subject', `Task orchestration ${stage.name}`,
    '--active-form', `Task orchestration ${stage.name}`,
    '--assigned-to', stage.agentRole,
    '--layer', 'audit',
    '--codebase', projectRoot(),
    '--template', stage.template,
    '--task-kind', stage.taskKind,
  ];
  if (stage.dependsOn?.length) args.push('--depends-on', ...stage.dependsOn);
  if (stage.parentTaskId) args.push('--parent-task-id', stage.parentTaskId);
  for (const artifact of resolveArtifacts(planName, planRoot, stage)) {
    args.push('--files-expected', JSON.stringify(artifact));
  }
  runLocalJson(args);
  existingTaskIds.add(stage.taskId);
}

function reconcileTask(planName: string, planRoot: string, stage: Stage, completedTaskIds: Set<string>): boolean {
  if (completedTaskIds.has(stage.taskId)) return false;
  const artifacts = resolveArtifacts(planName, planRoot, stage);
  if (!artifacts.length || !artifacts.every((artifact) => fileExists(artifact.path))) return false;
  for (const artifact of artifacts) {
    runLocalJson(['log-mutation', '--plan', planName, '--task-id', stage.taskId, '--path', artifact.path]);
  }
  runLocalJson([
    'complete',
    '--plan', planName,
    '--task-id', stage.taskId,
    '--caller', 'builder',
    '--discovered-context', '{"driftFromTDD":[],"filesCreated":[],"filesModified":[],"decisionsNotInTDD":[]}',
    '--self-audit', '{"assumptions":"none","shortcuts":"none","patternAlignment":"aligned"}',
  ]);
  completedTaskIds.add(stage.taskId);
  return true;
}

function finalTriageReportPath(planRoot: string, explicitPath?: string): string {
  return normalizePath(explicitPath ?? join(planRoot, FINAL_TRIAGE_REPORT));
}

function triageVerdict(path: string): 'clean' | 'blocked' | 'missing' | 'unknown' {
  if (!fileExists(path)) return 'missing';
  const text = readFileSync(path, 'utf8').trim();
  const lastLine = text.split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
  if (lastLine === 'Triage: CLEAN') return 'clean';
  if (lastLine.startsWith('Triage: BLOCKED')) return 'blocked';
  return 'unknown';
}

function descendantTaskIds(tasks: ReturnType<typeof summaryTasks>, parentTaskId: string): string[] {
  const children = new Map<string | null, string[]>();
  for (const task of tasks) {
    const key = task.parentTaskId ?? null;
    const current = children.get(key) ?? [];
    current.push(task.taskId);
    children.set(key, current);
  }
  const queue = [...(children.get(parentTaskId) ?? [])];
  const descendants: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    descendants.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return descendants;
}

function summarizeExecution(planName: string, planRoot: string, triageReport?: string) {
  const tasks = summaryTasks(planName);
  const descendants = descendantTaskIds(tasks, EXECUTE_TASK_ID);
  const descendantTasks = tasks.filter((task) => descendants.includes(task.taskId));
  const unresolvedWorkIds = descendantTasks
    .filter((task) => task.taskKind !== 'supervisor' && task.status !== 'completed')
    .map((task) => task.taskId);
  const needsRevisionTaskIds = descendantTasks.filter((task) => task.status === 'needs_revision').map((task) => task.taskId);
  const triagePath = finalTriageReportPath(planRoot, triageReport);
  const verdict = triageVerdict(triagePath);
  return {
    triageReportPath: triagePath,
    triageVerdict: verdict,
    remainingTaskIds: tasks.filter((task) => task.status !== 'completed').map((task) => task.taskId),
    unresolvedWorkIds,
    needsRevisionTaskIds,
    converged: unresolvedWorkIds.length === 0 && needsRevisionTaskIds.length === 0 && verdict === 'clean',
  };
}

function nextActions(planName: string, planRoot: string, triageReport?: string) {
  const tasks = summaryTasks(planName);
  const execution = summarizeExecution(planName, planRoot, triageReport);
  if (execution.needsRevisionTaskIds.length) {
    return { state: 'needs_revision', needsRevisionTaskIds: execution.needsRevisionTaskIds };
  }
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.taskId));
  const runnable = tasks.filter((task) => task.status === 'pending').filter((task) => (task.blockedBy ?? []).every((dep) => completed.has(dep)));
  const triage = runnable.filter((task) => task.taskKind === 'triage');
  const reviewers = runnable.filter((task) => task.taskKind === 'review');
  const builders = runnable.filter((task) => task.taskKind !== 'triage' && task.taskKind !== 'review' && task.taskKind !== 'supervisor');
  const inProgressTaskIds = tasks.filter((task) => task.status === 'in_progress').map((task) => task.taskId);
  return {
    state: triage.length ? 'dispatch-triage' : reviewers.length ? 'dispatch-reviewers' : builders.length ? 'dispatch-builders' : inProgressTaskIds.length ? 'waiting' : execution.converged ? 'converged' : 'blocked',
    triage,
    reviewers,
    builders,
    inProgressTaskIds,
    triageVerdict: execution.triageVerdict,
    unresolvedWorkIds: execution.unresolvedWorkIds,
  };
}

function resolveValidatedPlanRoot(options: { planName: string; planRoot?: string }): string {
  const planName = assertPlanSlug(options.planName, '--plan-name');
  const planRootCandidate = options.planRoot ?? join('.agents', 'runs', planName);
  return resolvePlanRoot(planRootCandidate);
}

function exitOnRuntimePathError<Options>(action: (options: Options) => void): (options: Options) => void {
  return (options) => {
    try {
      action(options);
    } catch (error) {
      if (!isRuntimePathError(error)) throw error;
      console.error(JSON.stringify(formatRuntimePathError(error)));
      process.exit(1);
    }
  };
}

const program = new Command();

program
  .command('validate-manifest')
  .action(exitOnRuntimePathError(() => {
    const manifest = loadManifest();
    const ids = new Set<string>();
    const errors: string[] = [];
    for (const stage of manifest.stages) {
      if (ids.has(stage.taskId)) errors.push(`Duplicate taskId: ${stage.taskId}`);
      ids.add(stage.taskId);
    }
    for (const stage of manifest.stages) {
      for (const dependency of stage.dependsOn ?? []) {
        if (!ids.has(dependency)) errors.push(`Unknown dependency '${dependency}' in ${stage.taskId}`);
      }
      if (stage.parentTaskId && !ids.has(stage.parentTaskId)) errors.push(`Unknown parentTaskId '${stage.parentTaskId}' in ${stage.taskId}`);
    }
    console.log(JSON.stringify({ success: errors.length === 0, errors }, null, 2));
    if (errors.length) process.exit(1);
  }));

program
  .command('materialize')
  .requiredOption('--plan-name <name>')
  .requiredOption('--stage <stage>')
  .option('--plan-root <path>')
  .action(exitOnRuntimePathError((options: { planName: string; stage: Stage['name']; planRoot?: string }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    mkdirSync(join(planRoot, 'spec'), { recursive: true });
    mkdirSync(join(planRoot, 'agent-outputs', 'planner'), { recursive: true });
    const manifest = loadManifest();
    const stageOrder = ['convert-to-spec', 'convert-to-tasks', 'plan-markdown', 'final-triage', 'execute'];
    const requestedIndex = stageOrder.indexOf(options.stage);
    const stages = manifest.stages.filter((stage) => stageOrder.indexOf(stage.name) <= requestedIndex);
    const existing = summaryTasks(options.planName);
    const existingTaskIds = new Set(existing.map((task) => task.taskId));
    const completedTaskIds = new Set(existing.filter((task) => task.status === 'completed').map((task) => task.taskId));
    let reconciled = 0;
    for (const stage of stages) {
      createTaskIfMissing(options.planName, planRoot, stage, existingTaskIds);
      if (reconcileTask(options.planName, planRoot, stage, completedTaskIds)) reconciled += 1;
    }
    upsertActivePlan({
      planName: options.planName,
      outputDir: planRoot,
      kind: 'task-orchestration',
      mode: options.stage,
      status: 'active',
      stopGuard: false,
      runner: 'task-orchestration-runner',
      updatedAt: new Date().toISOString(),
    });
    deleteIfExists(join(projectRoot(), LEGACY_ACTIVE_MARKER));
    console.log(JSON.stringify({ success: true, planName: options.planName, stage: options.stage, planRoot, tasksCreatedOrVerified: stages.length, reconciledCompletedTasks: reconciled }, null, 2));
  }));

program
  .command('status')
  .requiredOption('--plan-name <name>')
  .option('--plan-root <path>')
  .option('--triage-report <path>')
  .action(exitOnRuntimePathError((options: { planName: string; planRoot?: string; triageReport?: string }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    const execution = summarizeExecution(options.planName, planRoot, options.triageReport);
    console.log(JSON.stringify({
      planName: options.planName,
      planRoot,
      ...execution,
      outputs: {
        universalSpec: fileExists(join(planRoot, 'spec', 'universal-spec.md')),
        intakeManifest: fileExists(join(planRoot, 'agent-outputs', 'planner', '00_intake_manifest.md')),
        phaseStructure: fileExists(join(planRoot, 'agent-outputs', 'planner', '01_phase_structure.md')),
        agentSystem: fileExists(join(planRoot, 'AGENT_SYSTEM.md')),
        planMarkdown: fileExists(join(planRoot, `${options.planName}.md`)),
      },
      summary: runLocalJson(['summary', '--plan', options.planName]),
    }, null, 2));
  }));

program
  .command('next-actions')
  .requiredOption('--plan-name <name>')
  .option('--plan-root <path>')
  .option('--triage-report <path>')
  .action(exitOnRuntimePathError((options: { planName: string; planRoot?: string; triageReport?: string }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    console.log(JSON.stringify({ planName: options.planName, planRoot, ...nextActions(options.planName, planRoot, options.triageReport) }, null, 2));
  }));

program
  .command('complete-execute-if-clean')
  .requiredOption('--plan-name <name>')
  .option('--plan-root <path>')
  .option('--triage-report <path>')
  .action(exitOnRuntimePathError((options: { planName: string; planRoot?: string; triageReport?: string }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    const execution = summarizeExecution(options.planName, planRoot, options.triageReport);
    if (!execution.converged) {
      console.log(JSON.stringify({ success: false, reason: 'execute phase has not converged', ...execution }, null, 2));
      process.exit(1);
    }
    const executeTask = summaryTasks(options.planName).find((task) => task.taskId === EXECUTE_TASK_ID);
    if (!executeTask) {
      console.error(`Missing supervisor task: ${EXECUTE_TASK_ID}`);
      process.exit(1);
    }
    if (executeTask.status !== 'completed') {
      runLocalJson([
        'complete',
        '--plan', options.planName,
        '--task-id', EXECUTE_TASK_ID,
        '--caller', 'builder',
        '--discovered-context', '{"driftFromTDD":[],"filesCreated":[],"filesModified":[],"decisionsNotInTDD":[]}',
        '--self-audit', '{"assumptions":"none","shortcuts":"none","patternAlignment":"aligned"}',
      ]);
    }
    console.log(JSON.stringify({ success: true, planName: options.planName, triageReportPath: execution.triageReportPath, triageVerdict: execution.triageVerdict, executeCompleted: true }, null, 2));
  }));

program.parse(process.argv);

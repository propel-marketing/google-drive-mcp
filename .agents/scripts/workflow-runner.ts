#!/usr/bin/env tsx
import { Command } from 'commander';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { deleteIfExists, fileExists, loadJsonFile, normalizePath, projectRoot, resolvePlanRoot, runLocalJson, summaryTasks, upsertActivePlan } from './runner-helpers';
import { assertPlanSlug, formatRuntimePathError, isRuntimePathError } from './runtime-paths';

type WorkflowStage = {
  name: string;
  taskId: string;
  taskKind: string;
  agentRole: string;
  template: string;
  outputPath: string;
  completionMarker: 'exists';
  dependsOn?: string[];
  optional?: boolean;
};

type WorkflowManifest = {
  kind: 'workflow';
  stages: WorkflowStage[];
};

const LEGACY_ACTIVE_MARKER = join('.agents', 'active-managed-plan.json');
const MANIFEST_PATH = join('.agents', 'contracts', 'workflow.manifest.json');

function loadManifest(): WorkflowManifest {
  return loadJsonFile<WorkflowManifest>(normalizePath(MANIFEST_PATH));
}

function createTaskIfMissing(planName: string, planRoot: string, stage: WorkflowStage, existingTaskIds: Set<string>): void {
  if (existingTaskIds.has(stage.taskId)) {
    runLocalJson([
      'update',
      '--plan', planName,
      '--task-id', stage.taskId,
      '--owner', stage.agentRole,
      '--task-kind', stage.taskKind,
      '--caller', 'planner',
    ]);
    return;
  }
  const args = [
    'create',
    '--plan', planName,
    '--task-id', stage.taskId,
    '--subject', `Workflow ${stage.name}`,
    '--active-form', `Workflow ${stage.name}`,
    '--assigned-to', stage.agentRole,
    '--layer', 'audit',
    '--codebase', projectRoot(),
    '--template', stage.template,
    '--task-kind', stage.taskKind,
    '--files-expected', JSON.stringify({ path: join(planRoot, stage.outputPath), op: 'create', required: true }),
  ];
  if (stage.dependsOn?.length) args.push('--depends-on', ...stage.dependsOn);
  runLocalJson(args);
  existingTaskIds.add(stage.taskId);
}

function reconcileTask(planName: string, planRoot: string, stage: WorkflowStage, completedTaskIds: Set<string>): boolean {
  if (completedTaskIds.has(stage.taskId)) return false;
  const target = join(planRoot, stage.outputPath);
  if (!fileExists(target)) return false;
  runLocalJson(['log-mutation', '--plan', planName, '--task-id', stage.taskId, '--path', target]);
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
    }
    console.log(JSON.stringify({ success: errors.length === 0, errors }, null, 2));
    if (errors.length) process.exit(1);
  }));

program
  .command('materialize')
  .requiredOption('--plan-name <name>')
  .option('--plan-root <path>')
  .option('--enable-trace', 'Materialize trace as a prerequisite stage', false)
  .option('--enable-research', 'Materialize research as a prerequisite stage', false)
  .action(exitOnRuntimePathError((options: { planName: string; planRoot?: string; enableTrace?: boolean; enableResearch?: boolean }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    mkdirSync(join(planRoot, 'design'), { recursive: true });
    mkdirSync(join(planRoot, 'spec'), { recursive: true });
    const manifest = loadManifest();
    const existing = summaryTasks(options.planName);
    const existingTaskIds = new Set(existing.map((task) => task.taskId));
    const completedTaskIds = new Set(existing.filter((task) => task.status === 'completed').map((task) => task.taskId));
    const enabledOptionalStages = new Set<string>();
    if (options.enableTrace) enabledOptionalStages.add('trace');
    if (options.enableResearch) enabledOptionalStages.add('research');

    let reconciled = 0;
    for (const stage of manifest.stages) {
      createTaskIfMissing(options.planName, planRoot, stage, existingTaskIds);
      if (stage.optional && !enabledOptionalStages.has(stage.name)) {
        runLocalJson([
          'update',
          '--plan', options.planName,
          '--task-id', stage.taskId,
          '--notes', `Optional stage not required for this workflow plan: ${stage.name}`,
          '--caller', 'planner',
        ]);
      }
      if (reconcileTask(options.planName, planRoot, stage, completedTaskIds)) reconciled += 1;
    }

    upsertActivePlan({
      planName: options.planName,
      outputDir: planRoot,
      kind: 'workflow',
      mode: 'workflow',
      status: 'active',
      stopGuard: false,
      runner: 'workflow-runner',
      updatedAt: new Date().toISOString(),
    });
    deleteIfExists(join(projectRoot(), LEGACY_ACTIVE_MARKER));

    console.log(JSON.stringify({
      success: true,
      planName: options.planName,
      planRoot,
      optionalStagesEnabled: [...enabledOptionalStages],
      tasksCreatedOrVerified: manifest.stages.length,
      reconciledCompletedTasks: reconciled,
    }, null, 2));
  }));

program
  .command('status')
  .requiredOption('--plan-name <name>')
  .option('--plan-root <path>')
  .action(exitOnRuntimePathError((options: { planName: string; planRoot?: string }) => {
    const planRoot = resolveValidatedPlanRoot(options);
    const summary = runLocalJson(['summary', '--plan', options.planName]) as Record<string, unknown>;
    console.log(JSON.stringify({
      planName: options.planName,
      planRoot,
      outputs: {
        expertProbe: fileExists(join(planRoot, 'design', 'expert-probe.md')),
        preflight: fileExists(join(planRoot, 'design', 'preflight.md')),
        trace: fileExists(join(planRoot, 'design', 'trace.md')),
        research: fileExists(join(planRoot, 'design', 'research.md')),
        contextAcquisition: fileExists(join(planRoot, 'design', 'context-acquisition.md')),
        designDraft: fileExists(join(planRoot, 'design', 'design-draft.md')),
        universalSpec: fileExists(join(planRoot, 'spec', 'universal-spec.md')),
      },
      summary,
    }, null, 2));
  }));

program.parse(process.argv);

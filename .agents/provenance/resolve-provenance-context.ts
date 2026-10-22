import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import {
  ActivePlanRegistrySchema,
  ProvenanceActorContextSchema,
  type ProvenanceActorContext,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";

type ExtractedArgument = {
  value?: string;
  ambiguous: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findProjectRoot(cwd: string): string | undefined {
  let candidate = resolve(cwd);
  const filesystemRoot = parse(candidate).root;
  while (true) {
    if (existsSync(join(candidate, ".agents", "active-plans.json"))) {
      return candidate;
    }
    if (candidate === filesystemRoot) return undefined;
    candidate = dirname(candidate);
  }
}

function loadSingleActivePlanName(projectRoot: string): string | undefined {
  let rawRegistry: unknown;
  try {
    rawRegistry = JSON.parse(
      readFileSync(
        join(projectRoot, ".agents", "active-plans.json"),
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }

  if (!isRecord(rawRegistry) || !isRecord(rawRegistry.plans)) return undefined;
  if (Object.keys(rawRegistry).some((key) => key !== "plans")) return undefined;

  const schemaCandidate = Object.fromEntries(
    Object.entries(rawRegistry.plans).map(([planName, planValue]) => {
      if (!isRecord(planValue)) return [planName, planValue];
      return [
        planName,
        {
          ...planValue,
          planRoot: planValue.planRoot ?? planValue.outputDir,
          status: planValue.status === "paused" ? "completed" : planValue.status,
        },
      ];
    }),
  );
  const parsedRegistry = ActivePlanRegistrySchema.safeParse(schemaCandidate);
  if (!parsedRegistry.success) return undefined;

  const activePlanNames = Object.entries(parsedRegistry.data)
    .filter(([, plan]) => plan.status === undefined || plan.status === "active")
    .map(([planName]) => planName);
  return activePlanNames.length === 1 ? activePlanNames[0] : undefined;
}

function commandText(
  provenanceEvent: ValidatedProvenanceEvent,
): ExtractedArgument {
  const shellTools = new Set([
    "bash",
    "exec_command",
    "powershell",
    "shell",
  ]);
  if (
    provenanceEvent.toolName === undefined ||
    !shellTools.has(provenanceEvent.toolName.toLowerCase()) ||
    !isRecord(provenanceEvent.eventData)
  ) {
    return { ambiguous: false };
  }
  const toolInput = provenanceEvent.eventData.tool_input;
  if (!isRecord(toolInput)) return { ambiguous: false };
  const commands = [toolInput.command, toolInput.cmd].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const uniqueCommands = [...new Set(commands)];
  return {
    ...(uniqueCommands.length === 1 ? { value: uniqueCommands[0] } : {}),
    ambiguous: uniqueCommands.length > 1,
  };
}

function extractCommandArgument(
  command: string,
  argument: "plan" | "task-id",
): ExtractedArgument {
  const values = new Set<string>();
  const expression = new RegExp(
    `(?:^|\\s)--${argument}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s;&|]+))`,
    "g",
  );
  for (const match of command.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined && value.length > 0) values.add(value);
  }
  return {
    ...(values.size === 1 ? { value: [...values][0] } : {}),
    ambiguous: values.size > 1,
  };
}

function baseContext(
  provenanceEvent: ValidatedProvenanceEvent,
): ProvenanceActorContext {
  return ProvenanceActorContextSchema.parse({
    source: provenanceEvent.source,
    role: provenanceEvent.role,
    ...(provenanceEvent.agentId === undefined
      ? {}
      : { agentId: provenanceEvent.agentId }),
    ...(provenanceEvent.agentType === undefined
      ? {}
      : { agentType: provenanceEvent.agentType }),
  });
}

export class AdwProvenanceContextResolver {
  resolve(
    provenanceEvent: ValidatedProvenanceEvent,
  ): ProvenanceActorContext {
    const base = baseContext(provenanceEvent);
    const command = commandText(provenanceEvent);
    const planArgument = command.value === undefined
      ? { ambiguous: command.ambiguous }
      : extractCommandArgument(command.value, "plan");
    const taskArgument = command.value === undefined
      ? { ambiguous: command.ambiguous }
      : extractCommandArgument(command.value, "task-id");

    let workflowId = provenanceEvent.workflowId ?? planArgument.value;
    const taskId = provenanceEvent.taskId ?? taskArgument.value;

    if (
      workflowId === undefined &&
      !planArgument.ambiguous &&
      !command.ambiguous
    ) {
      const projectRoot = findProjectRoot(provenanceEvent.cwd);
      workflowId = projectRoot === undefined
        ? undefined
        : loadSingleActivePlanName(projectRoot);
    }

    return ProvenanceActorContextSchema.parse({
      ...base,
      ...(workflowId === undefined ? {} : { workflowId }),
      ...(taskId === undefined ? {} : { taskId }),
    });
  }
}

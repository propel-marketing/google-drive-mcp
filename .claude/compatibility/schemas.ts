import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:/.test(path), {
    message: "Expected a project-relative path",
  });

export const NativeAdwFileHashSchema = z.object({
  path: ProjectRelativePathSchema,
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
});

export const NativeAdwBaselineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sourceRoot: z.string().min(1),
  targetRoot: z.string().min(1),
  createdAt: z.string().datetime(),
  files: z.array(NativeAdwFileHashSchema),
});

export const ApprovedExistingFileChangeSchema = z.object({
  path: ProjectRelativePathSchema,
  baselineSha256: Sha256Schema,
  approvedSha256: Sha256Schema,
  approvalReference: z.string().min(1),
  reason: z.string().min(1),
  behaviorImpact: z.enum([
    "none",
    "required-compatibility",
    "additive-observability",
    "runtime-hardening",
    "additive-ergonomics",
  ]),
  verificationCommands: z.array(z.string().min(1)).min(1),
});

export const ApprovedExistingFileChangesManifestSchema = z.object({
  schemaVersion: z.literal(1),
  changes: z.array(ApprovedExistingFileChangeSchema),
});

export const ClaudeCompatibilityTransformationSchema = z.object({
  kind: z.enum([
    "byte-copy",
    "frontmatter-conversion",
    "harness-name-substitution",
    "harness-path-substitution",
    "tool-lifecycle-substitution",
    "behavior-neutral-wrapper",
  ]),
  sourceText: z.string(),
  targetText: z.string(),
  reason: z.string().min(1),
  expectedOccurrences: z.number().int().nonnegative(),
});

export const ClaudeCompatibilityFileSchema = z.object({
  category: z.enum(["instruction", "agent", "skill", "hook-wrapper"]),
  sourcePath: ProjectRelativePathSchema,
  mirrorPath: ProjectRelativePathSchema,
  sourceSha256: Sha256Schema,
  mirrorSha256: Sha256Schema,
  sourceByteLength: z.number().int().nonnegative(),
  mirrorByteLength: z.number().int().nonnegative(),
  generationMode: z.enum([
    "byte-copy",
    "transformed-copy",
    "agent-frontmatter",
    "behavior-neutral-wrapper",
  ]),
  transformations: z.array(ClaudeCompatibilityTransformationSchema),
});

export const ClaudeCompatibilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  sourceRoot: z.literal("."),
  targetRoot: z.literal("."),
  files: z.array(ClaudeCompatibilityFileSchema),
  counts: z.object({
    instructions: z.literal(1),
    agents: z.literal(23),
    skills: z.literal(165),
    byteIdenticalSkills: z.literal(164),
  }),
});

export type NativeAdwFileHash = z.infer<typeof NativeAdwFileHashSchema>;
export type NativeAdwBaselineManifest = z.infer<
  typeof NativeAdwBaselineManifestSchema
>;
export type ApprovedExistingFileChange = z.infer<
  typeof ApprovedExistingFileChangeSchema
>;
export type ApprovedExistingFileChangesManifest = z.infer<
  typeof ApprovedExistingFileChangesManifestSchema
>;
export type ClaudeCompatibilityTransformation = z.infer<
  typeof ClaudeCompatibilityTransformationSchema
>;
export type ClaudeCompatibilityFile = z.infer<
  typeof ClaudeCompatibilityFileSchema
>;
export type ClaudeCompatibilityManifest = z.infer<
  typeof ClaudeCompatibilityManifestSchema
>;

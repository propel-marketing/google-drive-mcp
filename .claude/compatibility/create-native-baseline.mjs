import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error("Usage: node create-native-baseline.mjs <source-root> <target-root>");
}

const sourceRoot = resolve(sourceArgument);
const targetRoot = resolve(targetArgument);
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  ".vercel",
  "logs",
  ".cache",
]);

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function excluded(relativePath, directoryEntry) {
  const parts = relativePath.split("/");
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  if (relativePath === ".agents/data" || relativePath.startsWith(".agents/data/")) return true;
  if (relativePath === ".agents/runs" || relativePath.startsWith(".agents/runs/")) return true;
  if (relativePath === ".claude/settings.local.json") return true;
  if (!directoryEntry.isDirectory() && parts.at(-1)?.startsWith(".env")) return true;
  return false;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = normalizedRelativePath(sourceRoot, absolutePath);
    if (excluded(relativePath, entry)) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(absolutePath));
    if (entry.isFile()) files.push({ absolutePath, relativePath });
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const files = sourceFiles(sourceRoot)
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  .map(({ absolutePath, relativePath }) => {
    const targetPath = join(targetRoot, ...relativePath.split("/"));
    if (!existsSync(targetPath)) throw new Error(`Missing target file: ${relativePath}`);
    const sourceSha256 = sha256(absolutePath);
    const targetSha256 = sha256(targetPath);
    if (sourceSha256 !== targetSha256) throw new Error(`Hash mismatch: ${relativePath}`);
    return {
      path: relativePath,
      sha256: sourceSha256,
      byteLength: statSync(absolutePath).size,
    };
  });

const outputPath = join(targetRoot, ".claude", "native-adw-baseline.json");
mkdirSync(join(targetRoot, ".claude"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  sourceRoot,
  targetRoot,
  createdAt: new Date().toISOString(),
  files,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ outputPath, fileCount: files.length }));

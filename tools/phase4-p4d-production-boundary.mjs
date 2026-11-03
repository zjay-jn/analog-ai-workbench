import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { P4D_BUILD_BOUNDARY_V1 } from "./phase4-p4d-matrix-contract.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const normalized = (value) => relative(repositoryRoot, value).split(sep).join("/");
const sha = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const raw = resolve(dirname(importer), specifier);
  for (const candidate of extname(raw) ? [raw, raw.replace(/\.js$/u, ".ts"), raw.replace(/\.js$/u, ".tsx")] : [raw, `${raw}.ts`, `${raw}.tsx`, resolve(raw, "index.ts"), resolve(raw, "index.tsx")]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* closed graph miss */ }
  }
  return null;
}
function graph(entries) {
  const pending = entries.map((entry) => resolve(repositoryRoot, entry));
  const visited = new Set();
  const externals = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const info = ts.preProcessFile(readFileSync(current, "utf8"), true, true);
    for (const imported of [...info.importedFiles, ...info.referencedFiles]) {
      const child = resolveImport(current, imported.fileName);
      if (child === null) externals.add(imported.fileName); else pending.push(child);
    }
  }
  return { files: [...visited].map(normalized).sort(), externals: [...externals].sort() };
}
function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(child)); else if (entry.isFile()) found.push(child);
  }
  return found;
}
function preloadMethods() {
  const file = resolve(repositoryRoot, "apps/desktop/src/preload/index.ts");
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let methods = null;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "workbenchApi" && node.initializer && ts.isCallExpression(node.initializer)) {
      const object = node.initializer.arguments[0];
      if (object && ts.isObjectLiteralExpression(object)) methods = object.properties.map((property) => property.name.getText(ast).replace(/["']/gu, "")).sort();
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return methods;
}
export function auditP4dProductionBoundaryV1() {
  const reachable = graph(P4D_BUILD_BOUNDARY_V1.productionEntries);
  const contamination = reachable.files.filter((file) => file.startsWith("tools/phase4-p4d-") || file.includes("index.dev") || file.includes("development-synthetic-agent-backend"));
  const mainGraph = graph(["apps/desktop/src/main/index.ts"]);
  const forbiddenMainExternals = mainGraph.externals.filter((entry) => ["node:fs", "node:fs/promises", "node:child_process", "node:http", "node:https", "node:net"].includes(entry));
  const expectedMethods = [...P4D_BUILD_BOUNDARY_V1.publicWorkbenchMethods].sort();
  const methods = preloadMethods();
  const forbiddenTokens = ["AAW_P4D", "phase4-p4d-test-main", "approved-synthetic-agent-fixtures.manifest.json", "development-synthetic-agent-backend", "source-events/message-delta.json"];
  const bundleMatches = [];
  for (const file of walk(resolve(repositoryRoot, "dist"))) {
    if (!/\.(?:js|html|css)$/u.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const token of forbiddenTokens) if (text.includes(token)) bundleMatches.push({ file: normalized(file), token });
  }
  const preloadRoot = resolve(repositoryRoot, "dist/preload");
  const preloadArtifacts = walk(preloadRoot).filter((file) => extname(file) === ".js");
  const expectedPreloadArtifact = resolve(preloadRoot, "preload/index.js");
  const preloadLocalRequires = preloadArtifacts.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/gu)].map((match) => ({
      file: normalized(file),
      specifier: match[1],
    }));
  });
  const preloadSingleFile = preloadArtifacts.length === 1 && preloadArtifacts[0] === expectedPreloadArtifact;
  const passed = contamination.length === 0
    && forbiddenMainExternals.length === 0
    && JSON.stringify(methods) === JSON.stringify(expectedMethods)
    && bundleMatches.length === 0
    && preloadSingleFile
    && preloadLocalRequires.length === 0;
  return Object.freeze({
    schemaVersion: "aaw.phase4.p4d.production-boundary/v1", passed,
    reachableFiles: Object.freeze(reachable.files), contamination: Object.freeze(contamination), forbiddenMainExternals: Object.freeze(forbiddenMainExternals),
    preloadMethods: Object.freeze(methods ?? []), expectedPreloadMethods: Object.freeze(expectedMethods), bundleMatches: Object.freeze(bundleMatches),
    preloadArtifacts: Object.freeze(preloadArtifacts.map(normalized)),
    preloadLocalRequires: Object.freeze(preloadLocalRequires),
    preloadSingleFile,
    bundleArtifacts: Object.freeze(walk(resolve(repositoryRoot, "dist")).filter((file) => /\.(?:js|html|css)$/u.test(file)).map((file) => ({ file: normalized(file), sha256: sha(file) }))),
    packageLockSha256: sha(resolve(repositoryRoot, "package-lock.json")),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = auditP4dProductionBoundaryV1();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

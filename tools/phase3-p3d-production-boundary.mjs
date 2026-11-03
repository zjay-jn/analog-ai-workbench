import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { P3D_BUILD_BOUNDARY_V1 } from "./phase3-p3d-matrix-contract.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function normalizedRelative(absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function sha256File(absolutePath) {
  return `sha256:${createHash("sha256")
    .update(readFileSync(absolutePath))
    .digest("hex")}`;
}

function resolveSourceImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = extname(raw)
    ? [
        raw,
        raw.replace(/\.js$/u, ".ts"),
        raw.replace(/\.js$/u, ".tsx"),
        raw.replace(/\.mjs$/u, ".mts"),
      ]
    : [
        raw,
        `${raw}.ts`,
        `${raw}.tsx`,
        `${raw}.mts`,
        resolve(raw, "index.ts"),
        resolve(raw, "index.tsx"),
      ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Candidate is not a source file in this closed graph.
    }
  }
  return null;
}

function sourceImports(absolutePath) {
  const sourceText = readFileSync(absolutePath, "utf8");
  const info = ts.preProcessFile(sourceText, true, true);
  return [...info.importedFiles, ...info.referencedFiles]
    .map((entry) => entry.fileName)
    .sort();
}

function reachableGraph(entryRelativePaths) {
  const pending = entryRelativePaths.map((entry) => resolve(repositoryRoot, entry));
  const visited = new Set();
  const externalSpecifiers = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of sourceImports(current)) {
      const resolvedImport = resolveSourceImport(current, specifier);
      if (resolvedImport === null) externalSpecifiers.add(specifier);
      else pending.push(resolvedImport);
    }
  }
  return Object.freeze({
    files: Object.freeze([...visited].map(normalizedRelative).sort()),
    externalSpecifiers: Object.freeze([...externalSpecifiers].sort()),
  });
}

function walkFiles(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  }
  return found.sort();
}

function preloadMethodSet() {
  const preloadPath = resolve(
    repositoryRoot,
    "apps/desktop/src/preload/index.ts",
  );
  const source = ts.createSourceFile(
    preloadPath,
    readFileSync(preloadPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let methods = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "workbenchApi" &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length === 1
    ) {
      const argument = node.initializer.arguments[0];
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        methods = argument.properties.map((property) => {
          if (
            (ts.isPropertyAssignment(property) ||
              ts.isMethodDeclaration(property) ||
              ts.isShorthandPropertyAssignment(property)) &&
            property.name !== undefined
          ) {
            return property.name.getText(source).replace(/["']/gu, "");
          }
          throw new Error("The public preload API contains a non-static property.");
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (methods === null) throw new Error("The public preload API object is unavailable.");
  return methods.sort();
}

export function auditP3dProductionBoundaryV1() {
  const graph = reachableGraph(P3D_BUILD_BOUNDARY_V1.productionEntries);
  const contaminatedFiles = graph.files.filter((file) =>
    P3D_BUILD_BOUNDARY_V1.productionForbiddenModulePrefixes.some((prefix) =>
      file.startsWith(prefix),
    ),
  );
  const mainGraph = reachableGraph(["apps/desktop/src/main/index.ts"]);
  const forbiddenMainFiles = mainGraph.files.filter(
    (file) =>
      file.includes("index.dev") ||
      file.includes("development-synthetic-reviewed-registry") ||
      file.includes("approved-synthetic-fixtures"),
  );
  const forbiddenMainExternals = mainGraph.externalSpecifiers.filter((specifier) =>
    ["node:fs", "node:fs/promises"].includes(specifier),
  );
  const preloadMethods = preloadMethodSet();
  const expectedMethods = [...P3D_BUILD_BOUNDARY_V1.publicPreloadMethods].sort();
  const bundleRoots = [
    resolve(repositoryRoot, "dist/main/main"),
    resolve(repositoryRoot, "dist/renderer"),
  ];
  const bundleFiles = bundleRoots.flatMap((root) => walkFiles(root));
  const bundleForbiddenMatches = [];
  for (const absolutePath of bundleFiles) {
    if (!/[.](?:js|html|css)$/u.test(absolutePath)) continue;
    const contents = readFileSync(absolutePath, "utf8");
    for (const token of P3D_BUILD_BOUNDARY_V1.productionForbiddenTokens) {
      if (contents.includes(token)) {
        bundleForbiddenMatches.push({
          file: normalizedRelative(absolutePath),
          token,
        });
      }
    }
    for (const token of [
      "tools/phase3-p3d-",
      "__AAW_P3D_",
      "aaw-p3d-unmount",
      "development-synthetic-reviewed-registry",
      "approved-synthetic-fixtures.manifest.json",
      "node:fs",
    ]) {
      if (contents.includes(token)) {
        bundleForbiddenMatches.push({
          file: normalizedRelative(absolutePath),
          token,
        });
      }
    }
  }
  const passed =
    contaminatedFiles.length === 0 &&
    forbiddenMainFiles.length === 0 &&
    forbiddenMainExternals.length === 0 &&
    JSON.stringify(preloadMethods) === JSON.stringify(expectedMethods) &&
    bundleForbiddenMatches.length === 0;
  return Object.freeze({
    schemaVersion: "aaw.phase3-p3d.production-boundary-audit/v1",
    passed,
    productionEntries: P3D_BUILD_BOUNDARY_V1.productionEntries,
    reachableFiles: graph.files,
    contaminatedFiles: Object.freeze(contaminatedFiles),
    forbiddenMainFiles: Object.freeze(forbiddenMainFiles),
    forbiddenMainExternals: Object.freeze(forbiddenMainExternals),
    preloadMethods: Object.freeze(preloadMethods),
    expectedPreloadMethods: Object.freeze(expectedMethods),
    bundleForbiddenMatches: Object.freeze(bundleForbiddenMatches),
    artifactHashes: Object.freeze(
      bundleFiles.map((file) =>
        Object.freeze({ file: normalizedRelative(file), sha256: sha256File(file) }),
      ),
    ),
    packageLockSha256: sha256File(resolve(repositoryRoot, "package-lock.json")),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = auditP3dProductionBoundaryV1();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

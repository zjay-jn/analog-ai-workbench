import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { MAIN_BUILD_PROFILES_V1 } from "../apps/desktop/src/main/build-profile";

type MainProfile = "production" | "development";

function parseSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function selectedProfile(filePath: string): MainProfile | null {
  const sourceFile = parseSource(filePath);
  let selected: MainProfile | null = null;
  const inspect = (node: ts.Node): void => {
    if (
      ts.isExportAssignment(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "createMainViteConfig"
    ) {
      const argument = node.expression.arguments[0];
      if (
        argument !== undefined &&
        ts.isStringLiteral(argument) &&
        (argument.text === "production" || argument.text === "development")
      ) {
        selected = argument.text;
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return selected;
}

function hasRuntimeBindings(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(unresolved);
  const candidates = extension.length > 0
    ? [
        unresolved,
        unresolved.replace(/\.mjs$/u, ".mts"),
        unresolved.replace(/\.js$/u, ".ts"),
        unresolved.replace(/\.jsx$/u, ".tsx"),
      ]
    : [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.mts`,
        path.join(unresolved, "index.ts"),
        path.join(unresolved, "index.tsx"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function runtimeGraph(entryPath: string): Readonly<{
  files: ReadonlySet<string>;
  externalImports: readonly string[];
}> {
  const pending = [path.resolve(entryPath)];
  const files = new Set<string>();
  const externalImports: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);
    const sourceFile = parseSource(current);
    const inspect = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        hasRuntimeBindings(node)
      ) {
        const specifier = node.moduleSpecifier.text;
        const local = resolveLocalModule(current, specifier);
        if (local === null) externalImports.push(specifier);
        else pending.push(local);
      }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        const local = resolveLocalModule(current, specifier);
        if (local === null) externalImports.push(specifier);
        else pending.push(local);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          const local = resolveLocalModule(current, argument.text);
          if (local === null) externalImports.push(argument.text);
          else pending.push(local);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }
  return Object.freeze({ files, externalImports: Object.freeze(externalImports) });
}

test("P3-C production and development use explicit separate main build profiles", () => {
  assert.deepEqual(MAIN_BUILD_PROFILES_V1, {
    production: {
      viteConfig: "apps/desktop/vite.main.config.mts",
      entry: "apps/desktop/src/main/index.ts",
      reviewedRegistry: "empty",
      agentBackend: "empty",
      fixtureLoaderReachable: false,
    },
    development: {
      viteConfig: "apps/desktop/vite.main.dev.config.mts",
      entry: "apps/desktop/src/main/index.dev.ts",
      reviewedRegistry: "synthetic-flat-basic-raw",
      agentBackend: "synthetic-approved-raw",
      fixtureLoaderReachable: true,
    },
  });
  assert.equal(selectedProfile(MAIN_BUILD_PROFILES_V1.production.viteConfig), "production");
  assert.equal(selectedProfile(MAIN_BUILD_PROFILES_V1.development.viteConfig), "development");
  const sharedViteConfig = readFileSync(
    "apps/desktop/vite.main.shared.mts",
    "utf8",
  );
  assert.match(
    sharedViteConfig,
    /__AAW_MAIN_DEVELOPMENT__:\s*JSON\.stringify\(profile === "development"\)/u,
  );
});

test("P3-C production renderer URL is guarded by a compile-time build literal", () => {
  const bootstrap = readFileSync(
    "apps/desktop/src/main/bootstrap.ts",
    "utf8",
  );
  assert.match(
    bootstrap,
    /const isDevelopment = __AAW_MAIN_DEVELOPMENT__;/u,
  );
  assert.match(
    bootstrap,
    /const developmentUrl = isDevelopment\s*\?\s*options\.developmentUrl\s*:\s*undefined;/u,
  );
  assert.match(
    bootstrap,
    /if \(isDevelopment && developmentUrl !== undefined\) \{\s*await window\.loadURL\(developmentUrl\);/u,
  );
});

test("P3-C production runtime graph wires the empty handler without fixture loader reachability", () => {
  const graph = runtimeGraph(MAIN_BUILD_PROFILES_V1.production.entry);
  const repoRelativeFiles = [...graph.files].map((filePath) =>
    path.relative(process.cwd(), filePath).replaceAll("\\", "/"),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/ipc/resolve-reviewed-artifact-handler.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/schematic/reviewed-artifact-registry.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/agent/empty-agent-backend.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/ipc/agent/register-agent-ipc.ts",
    ),
  );
  const forbiddenProductionModules = [
    "development-synthetic-reviewed-registry",
    "development-synthetic-agent-backend",
    "packages/schematic-workbench/fixtures/",
    "packages/agent-adapters/fixtures/",
    "packages/schematic-workbench/src/synthetic-admission.ts",
    "packages/agent-adapters/src/synthetic-agent-core.ts",
    "packages/windows-fs-native/",
    "apps/desktop/src/main/document/",
  ];
  for (const forbidden of forbiddenProductionModules) {
    assert.equal(
      repoRelativeFiles.some((filePath) => filePath.includes(forbidden)),
      false,
      forbidden,
    );
  }
  for (const forbiddenImport of [
    "node:fs",
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
  ]) {
    assert.equal(graph.externalImports.includes(forbiddenImport), false);
  }
});

test("P3-C development graph reaches only approved reviewed and P4-C raw synthetic loaders", () => {
  const graph = runtimeGraph(MAIN_BUILD_PROFILES_V1.development.entry);
  const repoRelativeFiles = [...graph.files].map((filePath) =>
    path.relative(process.cwd(), filePath).replaceAll("\\", "/"),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/schematic/development-synthetic-reviewed-registry.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/ipc/resolve-reviewed-artifact-handler.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/agent/development-synthetic-agent-backend.ts",
    ),
  );
  assert.ok(
    repoRelativeFiles.includes(
      "apps/desktop/src/main/ipc/agent/register-agent-ipc.ts",
    ),
  );
  for (const requiredP4Module of [
    "packages/agent-adapters/src/agent-contract.ts",
    "packages/agent-adapters/src/canonical-contract.ts",
    "packages/schematic-workbench/src/strict-source-frame.ts",
    "packages/agent-adapters/src/deterministic-synthetic-adapter.ts",
    "packages/agent-adapters/src/public-contract.ts",
  ]) {
    assert.ok(repoRelativeFiles.includes(requiredP4Module), requiredP4Module);
  }
  const developmentEntry = readFileSync(
    "apps/desktop/src/main/index.dev.ts",
    "utf8",
  );
  assert.match(
    developmentEntry,
    /const AGENT_MANIFEST_SHA256\s*=\s*\n?\s*"c71c984e1ae1b8500a55a6ddba67788d5c05e4cce51a7ec4670aa01325a88e8c";/u,
  );
  for (const approvedRawPath of [
    "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json",
    "packages/agent-adapters/fixtures/source-events/message-delta.json",
    "packages/agent-adapters/fixtures/source-events/run-completed.json",
    "packages/agent-adapters/fixtures/source-events/citation-text.json",
    "packages/agent-adapters/fixtures/source-events/citation-schematic.json",
    "packages/agent-adapters/fixtures/source-events/citation-rag.json",
    "packages/agent-adapters/fixtures/source-events/invalid-source-time.json",
    "packages/agent-adapters/fixtures/source-events/cancel-acknowledged.json",
    "packages/agent-adapters/fixtures/source-events/run-failed.json",
  ]) {
    assert.ok(developmentEntry.includes(approvedRawPath), approvedRawPath);
  }
  for (const forbiddenImport of [
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
  ]) {
    assert.equal(graph.externalImports.includes(forbiddenImport), false);
  }
  for (const forbiddenModule of [
    "packages/agent-adapters/src/synthetic-agent-core.ts",
    "packages/agent-adapters/fixtures/",
    "packages/windows-fs-native/",
    "services/python-bridge/",
    "/rag/",
    "/eda/",
    "/oa/",
    "/native/",
  ]) {
    assert.equal(
      repoRelativeFiles.some((filePath) => filePath.includes(forbiddenModule)),
      false,
      forbiddenModule,
    );
  }
});

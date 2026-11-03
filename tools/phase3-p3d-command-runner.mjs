import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  root,
  ".local/quality-evidence/20260901-phase3-p3d-exit-01/commands",
);
const npmCli = resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const commands = Object.freeze([
  ["npm-run-test-unit", process.execPath, [npmCli, "run", "test:unit"]],
  ["npm-run-typecheck", process.execPath, [npmCli, "run", "typecheck"]],
  ["npm-run-test-security", process.execPath, [npmCli, "run", "test:security"]],
  ["npm-run-build-main-dev", process.execPath, [npmCli, "run", "build:main:dev"]],
  ["npm-run-build", process.execPath, [npmCli, "run", "build"]],
  [
    "production-boundary",
    process.execPath,
    [resolve(root, "tools/phase3-p3d-production-boundary.mjs")],
  ],
]);

mkdirSync(output, { recursive: true });
let failed = false;
const summary = [];
for (const [id, command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const exitCode = result.status ?? 1;
  const log = [
    `$ ${command} ${args.join(" ")}`,
    result.stdout ?? "",
    result.stderr ?? "",
  ].join("\n");
  writeFileSync(resolve(output, `${id}.raw.log`), log, "utf8");
  writeFileSync(resolve(output, `${id}.exit-code.txt`), `${exitCode}\r\n`, "utf8");
  summary.push(Object.freeze({ id, exitCode }));
  if (exitCode !== 0) failed = true;
}

process.stdout.write(`${JSON.stringify({ failed, commands: summary }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const requestedFiles = requested.filter((argument) => argument.endsWith(".test.mjs"));
const testArguments = requested.filter((argument) => !argument.endsWith(".test.mjs"));
const testFiles = requestedFiles.length > 0
  ? requestedFiles.map((file) => path.resolve(projectRoot, file))
  : (await readdir(path.join(projectRoot, "tests")))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => path.join(projectRoot, "tests", file));
const testRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-test-run-"));

try {
  const child = spawn(process.execPath, ["--test", ...testArguments, ...testFiles], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MDVIEW_BROWSER: "none",
      MDVIEW_CACHE_DIR: path.join(testRoot, "cache"),
      MDVIEW_RUNTIME_DIR: path.join(testRoot, "runtime"),
      MDVIEW_STATE_DIR: path.join(testRoot, "state"),
      MDVIEW_LOG: path.join(testRoot, "mdview.log"),
      MDVIEW_PORT: "4322",
    },
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = signalExitCode(result.signal) ?? result.code ?? 1;
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

function signalExitCode(signal) {
  if (!signal) return null;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

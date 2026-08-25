#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...args] = process.argv.slice(2);
const developmentEnvironment = {
  ...process.env,
  MDVIEW_CACHE_DIR: path.join(os.homedir(), "Library", "Caches", "mdview", "development", "v1"),
  MDVIEW_RUNTIME_DIR: path.join(os.homedir(), "Library", "Application Support", "mdview", "development"),
  MDVIEW_PORT: "4321",
};

let command;
let commandArgs;
if (target === "cli") {
  command = process.execPath;
  commandArgs = [path.join(projectRoot, "src", "cli.mjs"), ...args];
} else if (target === "vite") {
  command = process.execPath;
  commandArgs = [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), ...args];
} else {
  process.stderr.write("Usage: run-development.mjs <cli|vite> [arguments...]\n");
  process.exitCode = 1;
}

if (command) {
  const child = spawn(command, commandArgs, {
    cwd: projectRoot,
    env: developmentEnvironment,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`mdview development command failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signalExitCode(signal) ?? code ?? 1;
  });
}

function signalExitCode(signal) {
  if (!signal) return null;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

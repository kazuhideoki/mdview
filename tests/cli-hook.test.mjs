import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("--hook accepts Codex JSON without a trailing newline and keeps stdout empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-cli-hook-"));
  const cwd = path.join(root, "作業 space");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "guide.md"), "# Guide\n");
  const payload = {
    session_id: "session",
    turn_id: "turn",
    cwd,
    hook_event_name: "UserPromptSubmit",
    transcript_path: null,
  };

  const result = await runHook(JSON.stringify(payload), {
    MDVIEW_STATE_DIR: path.join(root, "state"),
    MDVIEW_HOOK_LOG: path.join(root, "hook.log"),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

function runHook(input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "--hook"], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HOOK_COMMAND,
  getHookStatus,
  installHooks,
  managedHookGroup,
  uninstallHooks,
} from "../src/hook-manager.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mdview-hook-manager-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    hooksPath: path.join(directory, "hooks.json"),
  };
}

function targetHandler(overrides = {}) {
  return {
    type: "command",
    command: HOOK_COMMAND,
    timeout: 1,
    ...overrides,
  };
}

test("install creates the two matcher-free synchronous Codex hooks", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const result = await installHooks({ codexHome: directory });

  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), {
    hooks: {
      UserPromptSubmit: [managedHookGroup("UserPromptSubmit")],
      Stop: [managedHookGroup("Stop")],
    },
  });
  for (const eventName of ["UserPromptSubmit", "Stop"]) {
    const group = managedHookGroup(eventName);
    assert.equal("matcher" in group, false);
    assert.equal("async" in group.hooks[0], false);
  }
});

test("install preserves unrelated handlers in a mixed group and is idempotent", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const unrelated = { type: "command", command: "echo keep", timeout: 5 };
  const initial = {
    schemaVersion: 7,
    hooks: {
      UserPromptSubmit: [
        { matcher: "keep-this", label: "mixed", hooks: [targetHandler(), unrelated] },
        { label: "other", hooks: [{ type: "command", command: "echo second" }] },
      ],
      Stop: [{ hooks: [targetHandler({ statusMessage: "stale" })] }],
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo start" }] }],
    },
  };
  await writeFile(hooksPath, `${JSON.stringify(initial, null, 2)}\n`);

  const first = await installHooks({ codexHome: directory });
  const firstBytes = await readFile(hooksPath, "utf8");
  const installed = JSON.parse(firstBytes);
  assert.equal(first.installed, true);
  assert.deepEqual(installed.hooks.UserPromptSubmit[0], {
    matcher: "keep-this",
    label: "mixed",
    hooks: [unrelated],
  });
  assert.deepEqual(installed.hooks.UserPromptSubmit[1], initial.hooks.UserPromptSubmit[1]);
  assert.deepEqual(installed.hooks.SessionStart, initial.hooks.SessionStart);
  assert.equal(installed.schemaVersion, 7);
  assert.deepEqual(installed.hooks.UserPromptSubmit.at(-1), managedHookGroup("UserPromptSubmit"));
  assert.deepEqual(installed.hooks.Stop, [managedHookGroup("Stop")]);

  const second = await installHooks({ codexHome: directory });
  assert.equal(second.changed, false);
  assert.equal(await readFile(hooksPath, "utf8"), firstBytes);
});

test("uninstall removes only mdview handlers and keeps mixed groups", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const unrelated = { type: "command", command: "echo keep" };
  await writeFile(
    hooksPath,
    `${JSON.stringify({
      owner: "user",
      hooks: {
        UserPromptSubmit: [{ matcher: "still-here", hooks: [targetHandler(), unrelated] }],
        Stop: [managedHookGroup("Stop")],
        Notification: [{ hooks: [unrelated] }],
      },
    })}\n`,
  );

  const result = await uninstallHooks({ codexHome: directory });
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.equal(result.changed, true);
  assert.equal(result.installed, false);
  assert.deepEqual(config, {
    owner: "user",
    hooks: {
      UserPromptSubmit: [{ matcher: "still-here", hooks: [unrelated] }],
      Notification: [{ hooks: [unrelated] }],
    },
  });

  const second = await uninstallHooks({ codexHome: directory });
  assert.equal(second.changed, false);
});

test("status requires one current handler for both events", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  await writeFile(
    hooksPath,
    `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [managedHookGroup("UserPromptSubmit")],
        Stop: [{ matcher: "wrong", ...managedHookGroup("Stop") }],
      },
    })}\n`,
  );

  const status = await getHookStatus({ codexHome: directory });
  assert.equal(status.installed, false);
  assert.deepEqual(status.events.UserPromptSubmit, { count: 1, currentCount: 1, installed: true });
  assert.deepEqual(status.events.Stop, { count: 1, currentCount: 0, installed: false });
});

test("invalid JSON is rejected without changing the file", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const invalid = '{"hooks":';
  await writeFile(hooksPath, invalid);

  await assert.rejects(
    installHooks({ codexHome: directory }),
    (error) => error.code === "MDVIEW_HOOK_INVALID_JSON",
  );
  assert.equal(await readFile(hooksPath, "utf8"), invalid);
});

test("an existing lock rejects a write without changing hooks.json", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const source = '{"hooks":{}}\n';
  await writeFile(hooksPath, source);
  await writeFile(path.join(directory, ".mdview-hook.lock"), "other\n");

  await assert.rejects(
    installHooks({ codexHome: directory }),
    (error) => error.code === "MDVIEW_HOOK_LOCKED",
  );
  assert.equal(await readFile(hooksPath, "utf8"), source);
});

test("a symlinked hooks.json remains a symlink after an atomic update", async (t) => {
  const { directory, hooksPath } = await fixture(t);
  const target = path.join(directory, "managed-hooks.json");
  await writeFile(target, '{"hooks":{}}\n');
  await symlink(path.basename(target), hooksPath);

  await installHooks({ codexHome: directory });
  assert.equal((await lstat(hooksPath)).isSymbolicLink(), true);
  assert.equal((await getHookStatus({ codexHome: directory })).installed, true);
  assert.equal(JSON.parse(await readFile(target, "utf8")).hooks.Stop.length, 1);
});


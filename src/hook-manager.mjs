import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Keep $HOME literal so Codex expands it in the environment running the hook.
export const HOOK_COMMAND = '"$HOME/.local/bin/mdview" --hook';

export const HOOK_SPECS = Object.freeze({
  UserPromptSubmit: Object.freeze({
    timeout: 10,
    statusMessage: "Watching Markdown changes",
  }),
  Stop: Object.freeze({
    timeout: 30,
    statusMessage: "Updating Markdown preview",
  }),
});

export class HookConfigError extends Error {
  constructor(message, { code = "MDVIEW_HOOK_CONFIG", cause } = {}) {
    super(message, { cause });
    this.name = "HookConfigError";
    this.code = code;
  }
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function managerPaths(options = {}) {
  const codexHome = path.resolve(options.codexHome || defaultCodexHome());
  return {
    codexHome,
    hooksPath: path.resolve(options.hooksPath || path.join(codexHome, "hooks.json")),
    lockPath: path.resolve(options.lockPath || path.join(codexHome, ".mdview-hook.lock")),
  };
}

async function pathKind(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveWritableHooksPath(hooksPath) {
  const stat = await pathKind(hooksPath);
  if (!stat?.isSymbolicLink()) return hooksPath;

  try {
    return await realpath(hooksPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const target = await readlink(hooksPath);
    return path.resolve(path.dirname(hooksPath), target);
  }
}

function validateConfig(config, hooksPath) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new HookConfigError(`${hooksPath} must contain a JSON object.`);
  }
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
    throw new HookConfigError(`${hooksPath} has an unsupported hooks value.`);
  }

  for (const eventName of Object.keys(HOOK_SPECS)) {
    const groups = config.hooks?.[eventName];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) {
      throw new HookConfigError(`${hooksPath} has an unsupported hooks.${eventName} value.`);
    }
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) {
        throw new HookConfigError(`${hooksPath} has an unsupported ${eventName} hook group.`);
      }
    }
  }
  return config;
}

async function readConfig(hooksPath) {
  const writablePath = await resolveWritableHooksPath(hooksPath);
  let source;
  try {
    source = await readFile(writablePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { config: { hooks: {} }, writablePath, mode: undefined };
    }
    throw error;
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new HookConfigError(`${hooksPath} is not valid JSON.`, {
      code: "MDVIEW_HOOK_INVALID_JSON",
      cause: error,
    });
  }
  validateConfig(config, hooksPath);
  const stat = await pathKind(writablePath);
  return { config, writablePath, mode: stat?.mode };
}

function isTargetHandler(handler) {
  return Boolean(
    handler &&
      typeof handler === "object" &&
      !Array.isArray(handler) &&
      handler.type === "command" &&
      handler.command === HOOK_COMMAND,
  );
}

function expectedHandler(eventName) {
  const spec = HOOK_SPECS[eventName];
  return {
    type: "command",
    command: HOOK_COMMAND,
    timeout: spec.timeout,
    statusMessage: spec.statusMessage,
  };
}

function handlerIsCurrent(handler, eventName) {
  const expected = expectedHandler(eventName);
  return (
    isTargetHandler(handler) &&
    handler.timeout === expected.timeout &&
    handler.statusMessage === expected.statusMessage &&
    handler.async === undefined &&
    handler.matcher === undefined
  );
}

function stripTargetHandlers(groups) {
  const result = [];
  for (const group of groups || []) {
    const handlers = group.hooks.filter((handler) => !isTargetHandler(handler));
    if (handlers.length > 0) result.push({ ...group, hooks: handlers });
  }
  return result;
}

function installIntoConfig(config) {
  const next = structuredClone(config);
  next.hooks ||= {};
  for (const eventName of Object.keys(HOOK_SPECS)) {
    next.hooks[eventName] = [
      ...stripTargetHandlers(next.hooks[eventName]),
      { hooks: [expectedHandler(eventName)] },
    ];
  }
  return next;
}

function uninstallFromConfig(config) {
  const next = structuredClone(config);
  if (!next.hooks) return next;
  for (const eventName of Object.keys(HOOK_SPECS)) {
    if (!Array.isArray(next.hooks[eventName])) continue;
    const groups = stripTargetHandlers(next.hooks[eventName]);
    if (groups.length === 0) delete next.hooks[eventName];
    else next.hooks[eventName] = groups;
  }
  return next;
}

function inspectConfig(config, hooksPath) {
  validateConfig(config, hooksPath);
  const events = {};
  for (const eventName of Object.keys(HOOK_SPECS)) {
    let count = 0;
    let currentCount = 0;
    const groups = config.hooks?.[eventName] || [];
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (!isTargetHandler(handler)) continue;
        count += 1;
        if (
          handlerIsCurrent(handler, eventName) &&
          group.matcher === undefined &&
          group.async === undefined
        ) {
          currentCount += 1;
        }
      }
    }
    events[eventName] = {
      count,
      currentCount,
      installed: count === 1 && currentCount === 1,
    };
  }
  return {
    installed: Object.values(events).every((event) => event.installed),
    events,
  };
}

async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new HookConfigError("Another mdview hook configuration update is running.", {
        code: "MDVIEW_HOOK_LOCKED",
        cause: error,
      });
    }
    throw error;
  }
  return async () => {
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

async function atomicWriteJson(filePath, value, mode) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.mdview.${process.pid}.${Date.now()}`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: mode === undefined ? 0o600 : mode & 0o777,
    });
    if (mode !== undefined) await chmod(tempPath, mode & 0o777);
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function updateHooks(transform, options = {}) {
  const paths = managerPaths(options);
  const releaseLock = await acquireLock(paths.lockPath);
  try {
    const { config, writablePath, mode } = await readConfig(paths.hooksPath);
    const next = transform(config);
    const changed = JSON.stringify(next) !== JSON.stringify(config);
    if (changed) await atomicWriteJson(writablePath, next, mode);
    return {
      changed,
      hooksPath: paths.hooksPath,
      writablePath,
      ...inspectConfig(next, paths.hooksPath),
    };
  } finally {
    await releaseLock();
  }
}

export async function installHooks(options = {}) {
  return updateHooks(installIntoConfig, options);
}

export async function uninstallHooks(options = {}) {
  return updateHooks(uninstallFromConfig, options);
}

export async function getHookStatus(options = {}) {
  const paths = managerPaths(options);
  const { config, writablePath } = await readConfig(paths.hooksPath);
  return {
    hooksPath: paths.hooksPath,
    writablePath,
    ...inspectConfig(config, paths.hooksPath),
  };
}

// CLI-facing name: mirrors installHooks/uninstallHooks.
export const hooksStatus = getHookStatus;

export async function manageHooks(action, options = {}) {
  if (action === "install") return installHooks(options);
  if (action === "uninstall") return uninstallHooks(options);
  if (action === "status") return getHookStatus(options);
  throw new HookConfigError(`Unknown hook action: ${action}`, {
    code: "MDVIEW_HOOK_UNKNOWN_ACTION",
  });
}

// Exported for focused tests and callers that want to preview the managed shape.
export function managedHookGroup(eventName) {
  if (!HOOK_SPECS[eventName]) {
    throw new HookConfigError(`Unsupported hook event: ${eventName}`);
  }
  return { hooks: [expectedHandler(eventName)] };
}

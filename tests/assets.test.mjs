import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishAsset } from "../src/assets.mjs";

test("content-addressed assets keep different mdview versions side by side", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "viewer-source.js");
  const assets = path.join(root, "assets");

  await writeFile(source, "const version = 'new';\n");
  const newer = await publishAsset(source, "viewer.js", assets);
  await writeFile(source, "const version = 'old';\n");
  const older = await publishAsset(source, "viewer.js", assets);

  assert.notEqual(newer, older);
  assert.match(path.basename(newer), /^viewer[.][a-f0-9]{64}[.]js$/);
  assert.equal(await readFile(newer, "utf8"), "const version = 'new';\n");
  assert.equal(await readFile(older, "utf8"), "const version = 'old';\n");

  await writeFile(source, "const version = 'new';\n");
  assert.equal(await publishAsset(source, "viewer.js", assets), newer);
  assert.equal(await readFile(older, "utf8"), "const version = 'old';\n");
});

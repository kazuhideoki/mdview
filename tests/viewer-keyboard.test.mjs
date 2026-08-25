import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("command palettes support Control-N and Control-P selection", async () => {
  const source = await readFile(new URL("../src/viewer-entry.js", import.meta.url), "utf8");
  const definition = source.match(/function paletteSelectionDirection\(event\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(definition, "palette selection keyboard helper should exist");

  const direction = vm.runInNewContext(`(${definition})`);
  assert.equal(direction({ key: "ArrowDown" }), 1);
  assert.equal(direction({ key: "ArrowUp" }), -1);
  assert.equal(direction({ key: "n", ctrlKey: true }), 1);
  assert.equal(direction({ key: "p", ctrlKey: true }), -1);
  assert.equal(direction({ key: "n" }), 0);
  assert.equal(direction({ key: "n", ctrlKey: true, metaKey: true }), 0);
  assert.equal(direction({ key: "p", ctrlKey: true, isComposing: true }), 0);

  assert.equal(source.match(/paletteSelectionDirection\(event\)/g)?.length, 4,
    "workspace, outline, and document search palettes should share the helper");
});

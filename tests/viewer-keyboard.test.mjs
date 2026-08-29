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

test("outline palette previews selection and only keeps the position on confirmation", async () => {
  const source = await readFile(new URL("../src/viewer-entry.js", import.meta.url), "utf8");

  assert.match(source, /function setActiveOutlineResult\(index, scroll = true, preview = true\)/,
    "outline selection should opt into live document previews");
  assert.match(source, /if \(preview\) previewSelectedOutlineResult\(\)/,
    "moving the outline selection should preview its heading");
  assert.match(source, /withInstantScroll\(\(\) => heading\.scrollIntoView\(\{ block: "start" \}\)\)/,
    "live previews should track immediately instead of queueing smooth scrolls");
  assert.match(source, /outlinePaletteInput\.focus\(\{ preventScroll: true \}\)/,
    "opening the palette should not move the document before selection moves");
  assert.match(source, /const restorePosition = outlinePaletteState\.restoreScrollPosition;\s+if \(restorePosition\) scrollViewportInstantly/,
    "the opening frame should preserve the document position while the overlay takes focus");
  assert.match(source, /document\.body\.classList\.add\("mdv-outline-preview-open"\)/,
    "the outline palette should leave the document scrollable for live previews");
  assert.match(source, /closeOutlinePalette\(\{ restoreFocus: false, restoreScroll: false \}\)/,
    "confirming a heading should keep the previewed position");
  assert.match(source, /if \(restorePosition\) scrollViewportInstantly\(restorePosition\)/,
    "cancelling the palette should restore its opening position");
});

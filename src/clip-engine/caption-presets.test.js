import { test } from "vitest";
import assert from "node:assert/strict";
import { UserError } from "../lib/user-error";
import { CAPTION_POSITION_NAMES, CAPTION_PRESET_NAMES, captionPlacement, captionPreset } from "./remotion/caption-presets.js";
import { parseCaptionPosition, parseCaptionPreset } from "./helpers.js";

test("there are three caption presets, and each one has a text color", () => {
  assert.deepEqual(CAPTION_PRESET_NAMES, ["classic", "yellow", "box"]);
  for (const name of CAPTION_PRESET_NAMES) {
    assert.ok(captionPreset(name).color, `${name} needs a color`);
  }
});

test("captionPreset rejects a name that is not a preset", () => {
  assert.throws(() => captionPreset("neon"), /Unknown caption preset "neon"/);
  assert.throws(() => captionPreset("constructor"), /Unknown caption preset "constructor"/);
});

test("there are three caption positions, and each one places the captions", () => {
  assert.deepEqual(CAPTION_POSITION_NAMES, ["bottom", "middle", "top"]);
  for (const name of CAPTION_POSITION_NAMES) {
    assert.ok(captionPlacement(name), `${name} needs a placement`);
  }
  assert.throws(() => captionPlacement("left"), /Unknown caption position "left"/);
  assert.throws(
    () => parseCaptionPosition("left"),
    UserError,
  );
});

test("parseCaptionPreset accepts a preset name and rejects anything else as a UserError", () => {
  assert.equal(parseCaptionPreset("yellow"), "yellow");
  assert.throws(
    () => parseCaptionPreset("neon"),
    UserError,
  );
});

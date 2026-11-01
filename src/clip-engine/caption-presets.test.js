import { test } from "vitest";
import assert from "node:assert/strict";
import { UserError } from "../lib/user-error";
import {
  CAPTION_FONT_NAMES,
  CAPTION_POSITION_NAMES,
  CAPTION_PRESET_NAMES,
  captionFont,
  captionPlacement,
  captionPreset,
  VIDEO_COLOR_NAMES,
  videoColor,
} from "./remotion/caption-presets.js";
import {
  END_CARD_TEXT_MAX,
  HOOK_TEXT_MAX,
  parseCaptionFont,
  parseCaptionHighlight,
  parseCaptionPosition,
  parseCaptionPreset,
  parseEndCardText,
  parseHookMode,
  parseHookText,
  parseProgressBar,
} from "./helpers.js";

test("there are four caption presets, and each one has a text color", () => {
  assert.deepEqual(CAPTION_PRESET_NAMES, ["classic", "yellow", "box", "words"]);
  for (const name of CAPTION_PRESET_NAMES) {
    assert.ok(captionPreset(name).color, `${name} needs a color`);
  }
});

test("only the word-by-word preset highlights the spoken word", () => {
  for (const name of CAPTION_PRESET_NAMES) {
    const preset = captionPreset(name);
    assert.equal(preset.wordByWord, name === "words");
    assert.equal(Boolean(preset.highlight), preset.wordByWord, `${name} needs a highlight only when word by word`);
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

test("the default font is the system font the captions have always used; the others are shipped", () => {
  assert.deepEqual(CAPTION_FONT_NAMES, ["default", "montserrat", "anton", "bebas"]);
  assert.equal(captionFont("default").family, "sans-serif");
  assert.equal(captionFont("bebas").family, "Bebas Neue");
  assert.throws(() => captionFont("comic"), /Unknown caption font/);
});

test("every video colour is #rrggbb, and yellow is the highlight the word-by-word preset has always had", () => {
  for (const name of VIDEO_COLOR_NAMES) assert.match(videoColor(name), /^#[0-9a-f]{6}$/);
  assert.equal(videoColor("yellow"), captionPreset("words").highlight.background);
  assert.throws(() => videoColor("purple"), /Unknown video colour/);
});

test("parseCaptionFont and parseCaptionHighlight accept their names and reject anything else as a UserError", () => {
  assert.equal(parseCaptionFont("anton"), "anton");
  assert.throws(() => parseCaptionFont("Anton"), UserError);
  assert.throws(() => parseCaptionFont(undefined), UserError);
  assert.equal(parseCaptionHighlight("cyan"), "cyan");
  assert.throws(() => parseCaptionHighlight("#22d3ee"), UserError);
});

test("parseProgressBar gives null for off and a colour name otherwise", () => {
  assert.equal(parseProgressBar("off"), null);
  assert.equal(parseProgressBar("pink"), "pink");
  assert.throws(() => parseProgressBar(""), UserError);
  assert.throws(() => parseProgressBar(null), UserError);
});

test("parseHookMode and parseHookText: the text hook needs text, the others keep any text as it is", () => {
  assert.equal(parseHookMode("clipTitle"), "clipTitle");
  assert.throws(() => parseHookMode("title"), UserError);
  assert.equal(parseHookText("  Wait for it  ", "text"), "Wait for it");
  assert.throws(() => parseHookText("   ", "text"), /write the hook title/);
  assert.equal(parseHookText("", "off"), null);
  assert.equal(parseHookText("kept", "clipTitle"), "kept");
  assert.throws(() => parseHookText("x".repeat(HOOK_TEXT_MAX + 1), "text"), UserError);
  assert.throws(() => parseHookText(undefined, "off"), UserError);
});

test("parseEndCardText trims the text and gives null for none", () => {
  assert.equal(parseEndCardText(" @myhandle "), "@myhandle");
  assert.equal(parseEndCardText(""), null);
  assert.throws(() => parseEndCardText("x".repeat(END_CARD_TEXT_MAX + 1)), UserError);
});

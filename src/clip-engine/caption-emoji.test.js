import { test } from "vitest";
import assert from "node:assert/strict";
import { lineEmoji } from "./caption-emoji.js";

test("lineEmoji picks the emoji of a word spoken in the line", () => {
  assert.equal(lineEmoji(["show", "me", "the", "money"]), "💰");
  assert.equal(lineEmoji(["this", "is", "fire"]), "🔥");
  assert.equal(lineEmoji(["I", "love", "it"]), "❤️");
});

test("lineEmoji ignores case and the punctuation around a word", () => {
  assert.equal(lineEmoji(["That's", "CRAZY!"]), "🤯");
  assert.equal(lineEmoji(['"Money,"', "he", "said"]), "💰");
});

test("lineEmoji takes the first word that has an emoji", () => {
  assert.equal(lineEmoji(["we", "win", "the", "money"]), "🏆");
});

test("lineEmoji gives null for a line with no word in the map", () => {
  assert.equal(lineEmoji(["and", "then", "we", "left"]), null);
  assert.equal(lineEmoji([]), null);
});

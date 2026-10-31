import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeFakeEngines } from "./fake-slideshow-engines";
import { checkSlideCount, parseScript, scriptSchema, startLlamaServer, writeScript } from "./llm-script";

const three = JSON.stringify({
  slides: [
    { text: " Sleep is a skill. ", picture: "A bedroom at dusk" },
    { text: "Keep the room cool.", picture: "A thermostat at 18 degrees" },
    { text: "Put the phone away.", picture: "A phone face down on a nightstand" },
  ],
});

describe("parseScript", () => {
  it("returns the trimmed slides", () => {
    expect(parseScript(three, 3)).toEqual([
      { text: "Sleep is a skill.", picture: "A bedroom at dusk" },
      { text: "Keep the room cool.", picture: "A thermostat at 18 degrees" },
      { text: "Put the phone away.", picture: "A phone face down on a nightstand" },
    ]);
  });

  it("refuses an answer that is not the script asked for", () => {
    expect(() => parseScript("Sure! Here is", 3)).toThrow("not JSON");
    expect(() => parseScript(JSON.stringify({ lines: [] }), 3)).toThrow("no slides list");
    expect(() => parseScript(three, 4)).toThrow("3 slides instead of 4");
    expect(() => parseScript(JSON.stringify({ slides: [{ text: "a" }, { text: "b", picture: "c" }, { text: "d", picture: "e" }] }), 3)).toThrow(
      "slide 1 of the script lacks",
    );
    expect(() => parseScript(JSON.stringify({ slides: [{ text: " ", picture: "c" }] }), 1)).toThrow("slide 1 of the script is empty");
    expect(() => parseScript(JSON.stringify({ slides: [{ text: "x".repeat(201), picture: "c" }] }), 1)).toThrow("too long");
  });

  it("asks for exactly the slides wanted, each with both fields", () => {
    const schema = scriptSchema(6);
    expect(schema.properties.slides).toMatchObject({ minItems: 6, maxItems: 6 });
    expect(schema.properties.slides.items.required).toEqual(["text", "picture"]);
  });

  it("takes 3 to 10 slides", () => {
    expect(() => checkSlideCount(3)).not.toThrow();
    expect(() => checkSlideCount(10)).not.toThrow();
    for (const count of [2, 11, 4.5, Number.NaN]) expect(() => checkSlideCount(count)).toThrow("3 to 10 slides");
  });
});

describe("writeScript with a llama-server", () => {
  let root: string;
  let server: string;
  let record: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "llm-script-test-"));
    ({ server } = await writeFakeEngines(root));
    record = path.join(root, "llama.jsonl");
    process.env.FAKE_LLAMA_RECORD = record;
  });

  afterAll(async () => {
    delete process.env.FAKE_LLAMA_RECORD;
    delete process.env.FAKE_LLAMA_REPLY;
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFile(record, "");
    delete process.env.FAKE_LLAMA_REPLY;
  });

  const start = () => startLlamaServer({ server, model: "/models/qwen.gguf", logPath: path.join(root, "llama-server.log") });
  const entries = async () =>
    (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("starts it on 127.0.0.1, waits for the model, asks with the schema and stops it", async () => {
    const slides = await writeScript({ start, topic: "Better sleep", count: 4 });
    expect(slides).toHaveLength(4);
    expect(slides[0]).toEqual({ text: "Line 1.", picture: "Picture 1" });

    const [asked, stopped] = await entries();
    expect(asked.args).toEqual(expect.arrayContaining(["-m", "/models/qwen.gguf", "--host", "127.0.0.1", "--reasoning", "off"]));
    expect(asked.request.response_format).toEqual({ type: "json_object", schema: scriptSchema(4) });
    expect(asked.request.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(asked.request.messages[1].content).toContain("about: Better sleep");
    expect(asked.request.messages[1].content).toContain("exactly 4 slides");
    expect(stopped).toEqual({ stopped: true });
  });

  it("stops it when the answer does not parse", async () => {
    process.env.FAKE_LLAMA_REPLY = JSON.stringify({ slides: [] });
    await expect(writeScript({ start, topic: "Better sleep", count: 3 })).rejects.toThrow("0 slides instead of 3");
    expect((await entries()).at(-1)).toEqual({ stopped: true });
  });

  it("says why when the server does not start", async () => {
    await expect(startLlamaServer({ server: path.join(root, "missing"), model: "m", logPath: path.join(root, "missing.log") })).rejects.toThrow(
      "the script writer did not start",
    );
  });
});

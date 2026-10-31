import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { MAX_LINE_LENGTH, MAX_PICTURE_LENGTH, MAX_SLIDES, MIN_SLIDES } from "./slideshow-options";
import { UserError } from "./user-error";

// The script writer: llama.cpp's llama-server, started on 127.0.0.1 for one script and stopped after it. The answer is
// held to a JSON schema by llama.cpp's grammar sampling, so it always parses as { slides: [{ text, picture }] }.

const START_TIMEOUT_MS = 5 * 60_000;

export type ScriptSlide = { text: string; picture: string };
export type RunningLlm = { url: string; stop(): Promise<void> };
export type StartLlm = () => Promise<RunningLlm>;

export function scriptSchema(count: number) {
  return {
    type: "object",
    properties: {
      slides: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_LINE_LENGTH },
            picture: { type: "string", minLength: 1, maxLength: MAX_PICTURE_LENGTH },
          },
          required: ["text", "picture"],
          additionalProperties: false,
        },
      },
    },
    required: ["slides"],
    additionalProperties: false,
  };
}

export function checkSlideCount(count: number) {
  if (!Number.isInteger(count) || count < MIN_SLIDES || count > MAX_SLIDES) {
    throw new UserError(`a slideshow has ${MIN_SLIDES} to ${MAX_SLIDES} slides`);
  }
}

// The model's answer, checked against the schema it was given: exactly count slides, each a spoken line and a
// picture description, both non-empty after trimming.
export function parseScript(content: string, count: number): ScriptSlide[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`the script writer's answer is not JSON: ${content.slice(0, 200)}`);
  }
  const slides = (parsed as { slides?: unknown })?.slides;
  if (!Array.isArray(slides)) throw new Error("the script writer's answer has no slides list");
  if (slides.length !== count) throw new Error(`the script writer wrote ${slides.length} slides instead of ${count}`);
  return slides.map((slide: unknown, index) => {
    const { text, picture } = (slide ?? {}) as Record<string, unknown>;
    if (typeof text !== "string" || typeof picture !== "string") {
      throw new Error(`slide ${index + 1} of the script lacks its text or picture`);
    }
    const line = text.trim();
    const description = picture.trim();
    if (!line || !description) throw new Error(`slide ${index + 1} of the script is empty`);
    if (line.length > MAX_LINE_LENGTH || description.length > MAX_PICTURE_LENGTH) {
      throw new Error(`slide ${index + 1} of the script is too long`);
    }
    return { text: line, picture: description };
  });
}

function promptFor(topic: string, count: number): string {
  return [
    `Write the script of a vertical short video slideshow about: ${topic}`,
    `It has exactly ${count} slides. For each slide give "text", one short spoken sentence (at most 20 words) that a`,
    `narrator reads aloud, and "picture", a vivid description of a photo that fits that sentence, for an image`,
    "generator: the subject, the setting, the light and the camera angle, with no text or letters in the picture.",
    "The first line hooks the viewer and the last one wraps up. Plain English, no hashtags or emoji.",
  ].join(" ");
}

// Asks the running server for a script. Thinking is turned off: the answer is the JSON alone.
export async function requestScript({ url, topic, count }: { url: string; topic: string; count: number }): Promise<ScriptSlide[]> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You write scripts for short vertical videos." },
        { role: "user", content: promptFor(topic, count) },
      ],
      response_format: { type: "json_object", schema: scriptSchema(count) },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });
  if (!response.ok) throw new Error(`the script writer failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("the script writer gave no answer");
  return parseScript(content, count);
}

// A port nothing listens on right now, for this one run.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function healthy(url: string): Promise<boolean> {
  return fetch(`${url}/health`).then(
    (response) => response.ok,
    () => false,
  );
}

// Starts llama-server hidden on 127.0.0.1, with as many layers on the graphics card (Vulkan) as fit, and waits until
// the model has loaded. Its output goes to logPath.
export async function startLlamaServer({ server, model, logPath }: { server: string; model: string; logPath: string }): Promise<RunningLlm> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = await open(logPath, "w");
  const child = spawn(
    server,
    ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-c", "8192", "--reasoning", "off", "--no-webui"],
    { windowsHide: true, stdio: ["ignore", log.fd, log.fd] },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  let running = true;
  void exited.then(() => {
    running = false;
    return log.close();
  });
  const stop = async () => {
    if (!running) return;
    child.kill();
    await exited;
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await healthy(url))) {
    if (!running || Date.now() > deadline) {
      await stop();
      const tail = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).slice(-5).join("\n");
      throw new Error(`the script writer did not start${running ? " within 5 minutes" : ""}. The end of its log:\n${tail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { url, stop };
}

export async function writeScript({ start, topic, count }: { start: StartLlm; topic: string; count: number }): Promise<ScriptSlide[]> {
  const llm = await start();
  try {
    return await requestScript({ url: llm.url, topic, count });
  } finally {
    await llm.stop();
  }
}

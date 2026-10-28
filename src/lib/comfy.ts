import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { Workflow } from "./ai-workflow";

// Talks to ComfyUI over its HTTP API and websocket, and starts and stops it. Only the worker uses it.

export const COMFY_PORT = 8188;
const START_TIMEOUT_MS = 5 * 60_000;

export type RunningComfy = { url: string; stop(): Promise<void> };
export type StartComfy = () => Promise<RunningComfy>;
export type OutputFile = { filename: string; subfolder: string; type: string };

async function answers(url: string): Promise<boolean> {
  return fetch(`${url}/system_stats`).then(
    (response) => response.ok,
    () => false,
  );
}

// Starts the portable ComfyUI hidden, the way its run_nvidia_gpu.bat does, but only on 127.0.0.1 and without opening a
// browser, and waits until its API answers. Its output goes to comfyui.log next to it.
export async function startComfy(root: string): Promise<RunningComfy> {
  const url = `http://127.0.0.1:${COMFY_PORT}`;
  if (await answers(url)) throw new Error(`port ${COMFY_PORT} is already used by another ComfyUI; close it and try again`);

  const logPath = path.join(root, "..", "comfyui.log");
  const log = await open(logPath, "w");
  const child = spawn(
    path.join(root, "python_embeded", "python.exe"),
    ["-s", path.join("ComfyUI", "main.py"), "--listen", "127.0.0.1", "--port", String(COMFY_PORT), "--disable-auto-launch"],
    { cwd: root, windowsHide: true, stdio: ["ignore", log.fd, log.fd] },
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
  while (!(await answers(url))) {
    if (!running || Date.now() > deadline) {
      await stop();
      const tail = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).slice(-5).join("\n");
      throw new Error(`ComfyUI did not start${running ? " within 5 minutes" : ""}. The end of its log:\n${tail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { url, stop };
}

async function failure(response: Response, what: string): Promise<Error> {
  return new Error(`ComfyUI ${what} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

// Puts a picture in ComfyUI's input folder and returns the name a LoadImage node uses for it.
export async function uploadImage(url: string, file: string): Promise<string> {
  const form = new FormData();
  form.set("image", new Blob([await readFile(file)]), path.basename(file));
  form.set("overwrite", "true");
  const response = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!response.ok) throw await failure(response, "picture upload");
  const { name, subfolder } = (await response.json()) as { name: string; subfolder: string };
  return subfolder ? `${subfolder}/${name}` : name;
}

// Queues the workflow and follows it on the websocket until it has finished, reporting the progress of
// progressNode (0 to 1). Returns the files outputNode saved.
export async function runWorkflow({
  url,
  workflow,
  progressNode,
  outputNode,
  onProgress,
}: {
  url: string;
  workflow: Workflow;
  progressNode: string;
  outputNode: string;
  onProgress: (fraction: number) => void;
}): Promise<OutputFile[]> {
  const clientId = randomUUID();
  const promptId = randomUUID();
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("could not connect to ComfyUI's websocket"));
    });
    // Listening starts before the prompt is queued, so no message about it is missed.
    const finished = new Promise<void>((resolve, reject) => {
      socket.onclose = () => reject(new Error("ComfyUI closed the connection while making the video"));
      socket.onmessage = (event) => {
        // Binary messages are preview pictures.
        if (typeof event.data !== "string") return;
        const { type, data } = JSON.parse(event.data) as { type: string; data: Record<string, unknown> };
        if (data?.prompt_id !== promptId) return;
        if (type === "progress" && data.node === progressNode) onProgress(Number(data.value) / Number(data.max));
        if (type === "execution_success") resolve();
        if (type === "execution_error") reject(new Error(`ComfyUI failed: ${String(data.exception_message).trim()}`));
        if (type === "execution_interrupted") reject(new Error("ComfyUI stopped making the video"));
      };
    });
    // It can fail while the prompt is still being queued; it is awaited below, so that is not an unhandled rejection.
    finished.catch(() => undefined);
    const queued = await fetch(`${url}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId, prompt_id: promptId }),
    });
    if (!queued.ok) throw await failure(queued, "queueing the workflow");
    await finished;
  } finally {
    socket.onclose = null;
    socket.close();
  }

  const history = await fetch(`${url}/history/${promptId}`);
  if (!history.ok) throw await failure(history, "history");
  const entry = ((await history.json()) as Record<string, { outputs: Record<string, { images?: OutputFile[] }> }>)[promptId];
  const files = entry?.outputs[outputNode]?.images ?? [];
  if (files.length === 0) throw new Error("ComfyUI finished but saved no video");
  return files;
}

export async function downloadOutput(url: string, output: OutputFile, file: string): Promise<void> {
  const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type });
  const response = await fetch(`${url}/view?${query}`);
  if (!response.ok || !response.body) throw await failure(response, "video download");
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(file));
}

import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

// For tests: stand-ins for llama-server and sd-cli, written as Node scripts into dir. The fake llama-server answers
// /health (503 while "loading", then 200) and /v1/chat/completions with the slides the request's schema asks for (or,
// for a clip's title, a suggestion naming the request's number), or FAKE_LLAMA_REPLY, or never when that is "slow" (only to its first request when "slow-first"); it logs each request and its stop to FAKE_LLAMA_RECORD. The fake
// sd-cli logs its arguments to FAKE_SD_RECORD and copies FAKE_SD_PICTURE to its -o path, fails like a card out of
// memory when the prompt says so, or draws for a minute when the prompt says "slow", logging "drawing" once it can be
// stopped and "stopped" when it is.

const LLAMA_SERVER = String.raw`#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const record = (entry) => fs.appendFileSync(process.env.FAKE_LLAMA_RECORD, JSON.stringify(entry) + "\n");
let ready = false;
let answered = 0;
let requests = 0;
setTimeout(() => (ready = true), 300);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(ready ? 200 : 503).end(JSON.stringify(ready ? { status: "ok" } : { error: { code: 503, message: "Loading model" } }));
    return;
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const sent = JSON.parse(body);
      record({ args, request: sent });
      requests += 1;
      if (process.env.FAKE_LLAMA_REPLY === "slow" || (process.env.FAKE_LLAMA_REPLY === "slow-first" && requests === 1)) return;
      const { properties } = sent.response_format.schema;
      let answer;
      if (properties.slides) {
        const count = properties.slides.minItems;
        answer = { slides: Array.from({ length: count }, (_, index) => ({ text: " Line " + (index + 1) + ". ", picture: "Picture " + (index + 1) })) };
      } else {
        answered += 1;
        answer = { title: " Title " + answered + " ", description: "The first sentence. The second one.", hashtags: ["one", "two", "three"] };
      }
      const reply = process.env.FAKE_LLAMA_REPLY;
      const content = reply && reply !== "slow-first" ? reply : JSON.stringify(answer);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
    return;
  }
  response.writeHead(404).end();
});
server.listen(Number(arg("--port")), arg("--host"), () => console.log("server is listening"));
process.on("SIGTERM", () => {
  record({ stopped: true });
  process.exit(0);
});
`;

const SD_CLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(process.env.FAKE_SD_RECORD, JSON.stringify(args) + "\n");
if (arg("-p").includes("out of memory")) {
  console.error("ggml_vulkan: Device memory allocation of size 1073741824 failed.");
  process.exit(1);
}
if (arg("-p").includes("slow")) {
  process.on("SIGTERM", () => {
    fs.appendFileSync(process.env.FAKE_SD_RECORD, JSON.stringify("stopped") + "\n");
    process.exit(1);
  });
  fs.appendFileSync(process.env.FAKE_SD_RECORD, JSON.stringify("drawing") + "\n");
  setTimeout(() => {}, 60_000);
} else {
  fs.copyFileSync(process.env.FAKE_SD_PICTURE, arg("-o"));
}
`;

export async function writeFakeEngines(dir: string) {
  const server = path.join(dir, "llama-server");
  const cli = path.join(dir, "sd-cli");
  await writeFile(server, LLAMA_SERVER);
  await writeFile(cli, SD_CLI);
  await chmod(server, 0o755);
  await chmod(cli, 0o755);
  return { server, cli };
}

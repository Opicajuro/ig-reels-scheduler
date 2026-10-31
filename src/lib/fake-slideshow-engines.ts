import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

// For tests: stand-ins for llama-server and sd-cli, written as Node scripts into dir. The fake llama-server answers
// /health (503 while "loading", then 200) and /v1/chat/completions with the slides the request's schema asks for, or
// FAKE_LLAMA_REPLY; it logs each request and its stop to FAKE_LLAMA_RECORD. The fake sd-cli logs its arguments to
// FAKE_SD_RECORD and copies FAKE_SD_PICTURE to its -o path, or fails like a card out of memory when the prompt says so.

const LLAMA_SERVER = String.raw`#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const record = (entry) => fs.appendFileSync(process.env.FAKE_LLAMA_RECORD, JSON.stringify(entry) + "\n");
let ready = false;
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
      const count = sent.response_format.schema.properties.slides.minItems;
      const slides = Array.from({ length: count }, (_, index) => ({ text: " Line " + (index + 1) + ". ", picture: "Picture " + (index + 1) }));
      const content = process.env.FAKE_LLAMA_REPLY || JSON.stringify({ slides });
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
fs.copyFileSync(process.env.FAKE_SD_PICTURE, arg("-o"));
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

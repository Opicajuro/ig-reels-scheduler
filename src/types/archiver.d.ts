// The part of archiver this app uses. archiver 7 ships no types of its own.
declare module "archiver" {
  import type { Writable } from "node:stream";

  interface Archive {
    pipe(destination: Writable): Archive;
    file(filename: string, data: { name: string }): Archive;
    append(source: string, data: { name: string }): Archive;
    finalize(): Promise<void>;
    on(event: "error", listener: (err: Error) => void): Archive;
  }

  export default function archiver(format: "zip", options?: { zlib?: { level?: number } }): Archive;
}

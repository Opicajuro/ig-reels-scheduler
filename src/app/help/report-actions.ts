"use server";

import { spawn } from "node:child_process";
import packageJson from "../../../package.json";
import { runAction, type ActionResult } from "@/lib/action-result";
import { requireEnv } from "@/lib/env";
import { gatherReportFacts, writeProblemReport } from "@/lib/problem-report";
import { prisma } from "@/lib/prisma";

// The app runs on the PC it is used on, so on Windows the reports folder opens in Explorer with the new ZIP selected.
export async function reportProblemAction(): Promise<ActionResult> {
  return runAction(async () => {
    const dataDir = requireEnv("LOCALIRS_DATA_DIR");
    const now = new Date();
    const facts = await gatherReportFacts(prisma, dataDir, packageJson.version);
    const zipPath = await writeProblemReport({ dataDir, facts, now });
    if (process.platform !== "win32") return `Report saved to ${zipPath}`;
    spawn("explorer.exe", [`/select,"${zipPath}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return `Report saved to ${zipPath}. Its folder is open in Explorer.`;
  });
}

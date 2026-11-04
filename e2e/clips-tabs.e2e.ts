import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

const TABS = ["From a video", "From a description (AI)", "Slideshow"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const base = requireEnv("E2E_URL");
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: requireEnv("CHROME_PATH") });
});

afterAll(async () => {
  await browser.close();
});

// Opens the page, failing the test on any script error in it.
async function open(path: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(path, base).href, { waitUntil: "networkidle" });
  return { page, errors };
}

// The tab shown and the panels visible, by their names.
async function shown(page: Page) {
  const selected = await page.locator('[role="tab"][aria-selected="true"]').allTextContents();
  const panels = await page.locator('[role="tabpanel"]:visible').evaluateAll((elements) =>
    elements.map((panel) => document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent),
  );
  return { selected, panels };
}

describe("Clips tabs", () => {
  it("shows each tab's panel when it is clicked", async () => {
    const { page, errors } = await open("/clips");
    expect(await shown(page)).toEqual({ selected: ["From a video"], panels: ["From a video"] });
    for (const name of [...TABS.slice(1), TABS[0]]) {
      await page.getByRole("tab", { name, exact: true }).click();
      expect(await shown(page)).toEqual({ selected: [name], panels: [name] });
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  it("opens the tab ?tab= asks for, also when the Clips page was already open", async () => {
    const { page, errors } = await open("/clips?tab=ai");
    expect(await shown(page)).toEqual({ selected: ["From a description (AI)"], panels: ["From a description (AI)"] });

    // As the Queue page's links do after a visit to Clips: Next keeps the visited Clips page and reuses it.
    await page.goto(new URL("/clips", base).href, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "From a video", exact: true }).click();
    await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push("/clips?tab=slideshow"));
    await page.waitForURL(/tab=slideshow/);
    await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ selected: ["Slideshow"], panels: ["Slideshow"] });
    await page.getByRole("tab", { name: "From a description (AI)", exact: true }).click();
    expect(await shown(page)).toEqual({ selected: ["From a description (AI)"], panels: ["From a description (AI)"] });
    expect(errors).toEqual([]);
    await page.close();
  });
});

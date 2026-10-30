import type { PrismaClient } from "@/generated/prisma/client";
import { UserError } from "./user-error";

// The designs the app can wear. Each is a token set in src/app/globals.css under [data-design="…"].
export const DESIGNS = {
  night: { name: "Night Spring", description: "Dark glass, soft glows and springy buttons." },
  neon: { name: "Neon Studio", description: "Deep black with violet and cyan light." },
  cut: { name: "Cutting Room", description: "A film editor's bench: serif titles and tape orange." },
  day: { name: "Daylight Pro", description: "Bright and airy, with soft depth." },
  cast: { name: "Broadcast", description: "Sports-TV energy: heavy type and hard shadows." },
} as const;

// Night Spring's colour palettes, each a [data-palette="…"] override in globals.css. The two colours draw its chip.
export const PALETTES = {
  default: { name: "Violet & mint", colors: ["#7c5cff", "#2ee6a6"] },
  ember: { name: "Ember", colors: ["#ff5e3a", "#ffc145"] },
  ocean: { name: "Ocean", colors: ["#1e9bff", "#33e1d0"] },
  forest: { name: "Forest", colors: ["#22c55e", "#d9f99d"] },
  rose: { name: "Rose", colors: ["#ec4899", "#a78bfa"] },
  gold: { name: "Gold", colors: ["#e0a82e", "#f5f0e1"] },
} as const;

export type Design = keyof typeof DESIGNS;
export type Palette = keyof typeof PALETTES;

// hue turns every design's colours around the colour wheel, in degrees (0 keeps them as designed).
export type Appearance = { design: Design; palette: Palette; hue: number };

const SETTINGS_ID = 1;

function isDesign(value: string): value is Design {
  return Object.hasOwn(DESIGNS, value);
}

function isPalette(value: string): value is Palette {
  return Object.hasOwn(PALETTES, value);
}

// Read by the root layout on every request, so the page arrives already wearing the saved design.
export async function getAppearance(db: PrismaClient): Promise<Appearance> {
  const row = await db.setting.findUnique({ where: { id: SETTINGS_ID }, select: { design: true, palette: true, hue: true } });
  if (!row) return { design: "night", palette: "default", hue: 0 };
  if (!isDesign(row.design) || !isPalette(row.palette)) {
    throw new Error(`the saved appearance is unknown: design ${row.design}, palette ${row.palette}`);
  }
  return { design: row.design, palette: row.palette, hue: row.hue };
}

// What the Appearance form sends, as typed.
export type AppearanceInput = { design: string; palette: string; hue: string };

export async function saveAppearance(db: PrismaClient, input: AppearanceInput): Promise<void> {
  if (!isDesign(input.design)) throw new UserError(`there is no design called ${input.design}`);
  if (!isPalette(input.palette)) throw new UserError(`there is no colour palette called ${input.palette}`);
  const hue = Number(input.hue);
  if (!/^\d+$/.test(input.hue) || hue > 359) throw new UserError("the colour shift must be a whole number from 0 to 359");

  const data = { design: input.design, palette: input.palette, hue };
  await db.setting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

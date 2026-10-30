import { UserError } from "./user-error";

// The longest link the app stores.
export const MAX_LINK_LENGTH = 2000;

// Known platforms by the domains their links use. A link on a subdomain (m.youtube.com, vm.tiktok.com) counts too.
const PLATFORMS: Array<{ name: string; domains: string[] }> = [
  { name: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { name: "Twitch", domains: ["twitch.tv"] },
  { name: "TikTok", domains: ["tiktok.com"] },
  { name: "Instagram", domains: ["instagram.com"] },
  { name: "Facebook", domains: ["facebook.com", "fb.com", "fb.watch"] },
  { name: "X", domains: ["x.com", "twitter.com"] },
  { name: "Vimeo", domains: ["vimeo.com"] },
  { name: "Kick", domains: ["kick.com"] },
];

// The platform a link is on, from its host: "YouTube", "TikTok", …, or the host itself without "www." for any other site.
export function platformName(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const platform = PLATFORMS.find(({ domains }) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  return platform ? platform.name : host.replace(/^www\./, "");
}

// A link the owner pasted: an http or https address of at most MAX_LINK_LENGTH characters.
export function parseLinkUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError("paste a link");
  if (text.length > MAX_LINK_LENGTH) throw new UserError(`the link is longer than ${MAX_LINK_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UserError("the link is not a valid web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("the link must start with http:// or https://");
  return url.href;
}

import { describe, expect, it } from "vitest";
import { MAX_LINK_LENGTH, parseLinkUrl, platformName } from "./platforms";
import { UserError } from "./user-error";

describe("platformName", () => {
  it("names the known platforms from the link's host, subdomains included", () => {
    expect(platformName("https://www.youtube.com/watch?v=abc")).toBe("YouTube");
    expect(platformName("https://youtu.be/abc")).toBe("YouTube");
    expect(platformName("https://m.youtube.com/shorts/abc")).toBe("YouTube");
    expect(platformName("https://www.twitch.tv/videos/1")).toBe("Twitch");
    expect(platformName("https://clips.twitch.tv/Abc")).toBe("Twitch");
    expect(platformName("https://vm.tiktok.com/xyz/")).toBe("TikTok");
    expect(platformName("https://www.instagram.com/reel/abc/")).toBe("Instagram");
    expect(platformName("https://fb.watch/abc/")).toBe("Facebook");
    expect(platformName("https://www.facebook.com/reel/1")).toBe("Facebook");
    expect(platformName("https://x.com/me/status/1")).toBe("X");
    expect(platformName("https://twitter.com/me/status/1")).toBe("X");
    expect(platformName("https://vimeo.com/1")).toBe("Vimeo");
    expect(platformName("https://kick.com/me")).toBe("Kick");
  });

  it("names any other site by its host without www.", () => {
    expect(platformName("https://www.example.org/video")).toBe("example.org");
    expect(platformName("http://videos.example.com/1")).toBe("videos.example.com");
  });

  it("does not take a look-alike domain for a platform", () => {
    expect(platformName("https://notyoutube.com/watch")).toBe("notyoutube.com");
    expect(platformName("https://youtube.com.evil.example/watch")).toBe("youtube.com.evil.example");
  });
});

describe("parseLinkUrl", () => {
  it("accepts http and https links, trimmed", () => {
    expect(parseLinkUrl("  https://youtu.be/abc ")).toBe("https://youtu.be/abc");
    expect(parseLinkUrl("http://example.com")).toBe("http://example.com/");
  });

  it("refuses anything that is not an http or https link", () => {
    for (const value of ["", "   ", "not a link", "javascript:alert(1)", "ftp://example.com/a", "mailto:me@example.com", 42]) {
      expect(() => parseLinkUrl(value)).toThrow(UserError);
    }
  });

  it(`refuses a link longer than ${MAX_LINK_LENGTH} characters`, () => {
    const base = "https://example.com/";
    expect(parseLinkUrl(base + "a".repeat(MAX_LINK_LENGTH - base.length))).toHaveLength(MAX_LINK_LENGTH);
    expect(() => parseLinkUrl(base + "a".repeat(MAX_LINK_LENGTH - base.length + 1))).toThrow(UserError);
  });
});

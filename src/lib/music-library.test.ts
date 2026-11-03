import { describe, expect, it } from "vitest";
import library from "@/clip-engine/music-library.json";
import { creditLine, hasCredit, MUSIC_TRACKS, parseMusicChoice, TRACKS, withCredit } from "./music-library";

// Where a track may come from: CC0 music from OpenGameArt, Kenney's CC0 audio, Kevin MacLeod's CC BY 4.0 music.
const SOURCES: Record<string, { hosts: string[]; licences: string[] }> = {
  opengameart: { hosts: ["opengameart.org"], licences: ["CC0-1.0"] },
  kenney: { hosts: ["kenney.nl", "github.com"], licences: ["CC0-1.0"] },
  "kevin-macleod": { hosts: ["incompetech.com"], licences: ["CC-BY-4.0"] },
};
const FORBIDDEN = /pixabay|mixkit|youtube|youtu\.be|epidemicsound|artlist/i;

describe("music-library.json", () => {
  it("records a source page, licence, author, check date and a pinned file for every track", () => {
    expect(library.tracks.length).toBeGreaterThan(0);
    for (const track of library.tracks) {
      const where = `track ${track.id}`;
      expect(track.id, where).toMatch(/^[a-z0-9-]+$/);
      expect(["music", "sfx"], where).toContain(track.kind);
      expect(track.title.trim(), where).not.toBe("");
      expect(track.author.trim(), where).not.toBe("");
      expect(track.checked, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(track.checked)), where).toBe(false);
      expect(track.sha256, where).toMatch(/^[0-9a-f]{64}$/);
      expect(track.bytes, where).toBeGreaterThan(0);
      expect(track.seconds, where).toBeGreaterThan(0);
      expect(track.provenance.trim(), where).not.toBe("");
      expect(track.file, where).toMatch(new RegExp(`^${track.id}\\.(ogg|mp3)$`));
      // Downloads come from a fixed commit, so the bytes cannot change under the hash.
      expect(track.url, where).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/.+\.(ogg|mp3)$/);

      const source = SOURCES[track.collection];
      expect(source, `${where} comes from ${track.collection}`).toBeDefined();
      expect(source.licences, where).toContain(track.licence);
      expect(source.hosts, where).toContain(new URL(track.sourceUrl).hostname);
      expect(track.licenceUrl, where).toBe(
        track.licence === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : "https://creativecommons.org/licenses/by/4.0/",
      );
      for (const value of [track.sourceUrl, track.url, track.provenance]) expect(value, where).not.toMatch(FORBIDDEN);
    }
  });

  it("gives every CC BY track the credit line incompetech asks for, and no CC0 track one", () => {
    for (const track of TRACKS) {
      if (track.licence === "CC-BY-4.0") {
        expect(track.credit).toBe(
          `"${track.title}" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/`,
        );
      } else {
        expect(track.credit, track.id).toBeUndefined();
      }
    }
  });

  it("has unique ids, files and hashes", () => {
    for (const key of ["id", "file", "sha256"] as const) {
      const values = library.tracks.map((track) => track[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });
});

describe("credit line", () => {
  const ccBy = MUSIC_TRACKS.find((track) => track.licence === "CC-BY-4.0")!;
  const cc0 = MUSIC_TRACKS.find((track) => track.licence === "CC0-1.0")!;

  it("is added to the caption of a clip with CC BY music, once", () => {
    const credit = creditLine(ccBy.id)!;
    expect(credit).toContain("Kevin MacLeod");
    const caption = withCredit("Watch this", ccBy.id);
    expect(caption).toBe(`Watch this\n\n${credit}`);
    expect(withCredit(caption, ccBy.id)).toBe(caption);
    expect(withCredit("", ccBy.id)).toBe(credit);
    expect(hasCredit(caption, ccBy.id)).toBe(true);
    expect(hasCredit("Watch this", ccBy.id)).toBe(false);
  });

  it("leaves the caption alone for CC0 music or none", () => {
    expect(creditLine(cc0.id)).toBeNull();
    expect(creditLine(null)).toBeNull();
    expect(withCredit("Watch this", cc0.id)).toBe("Watch this");
    expect(withCredit("Watch this", null)).toBe("Watch this");
    expect(hasCredit("Watch this", cc0.id)).toBe(true);
  });

  it("throws for a track that is not in the library", () => {
    expect(() => creditLine("gone")).toThrow('unknown music track "gone"');
  });
});

describe("parseMusicChoice", () => {
  it("takes a music track and a volume of 0-100, or none", () => {
    expect(parseMusicChoice("", "15")).toEqual({ musicTrack: null, musicVolume: 15 });
    expect(parseMusicChoice(MUSIC_TRACKS[0].id, "100")).toEqual({ musicTrack: MUSIC_TRACKS[0].id, musicVolume: 100 });
  });

  it("refuses a sound effect, an unknown track and a volume out of range", () => {
    const sfx = TRACKS.find((track) => track.kind === "sfx")!;
    expect(() => parseMusicChoice(sfx.id, "15")).toThrow("unknown music track");
    expect(() => parseMusicChoice("nope", "15")).toThrow("unknown music track");
    for (const volume of ["", "-1", "101", "12.5", "loud"]) expect(() => parseMusicChoice("", volume)).toThrow("from 0 to 100");
  });
});

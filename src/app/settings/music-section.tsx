import { Card } from "@/components/card";
import { TRACKS, type MusicTrack } from "@/lib/music-library";
import styles from "./settings.module.css";

function TrackList({ tracks }: { tracks: MusicTrack[] }) {
  return (
    <ul className={styles.library}>
      {tracks.map((track) => (
        <li key={track.id}>
          <span>
            {track.title} · {track.author}
          </span>
          <span className={styles.note}>
            {track.licence} ·{" "}
            <a href={track.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>{" "}
            · licence checked {track.checked}
          </span>
          <audio controls preload="none" src={`/api/music/${track.id}`} />
        </li>
      ))}
    </ul>
  );
}

// The built-in music and sound effects, with where each comes from, its licence and when that was checked, for a
// dispute if Instagram mutes a Reel. They are all free to use in public, monetised posts.
export function MusicSection() {
  return (
    <>
      <h2 id="music">Music and sound effects</h2>
      <Card>
        <p className={styles.note}>
          Built in and free to use in public posts, including on monetised accounts: CC0 music from OpenGameArt, Kevin
          MacLeod&apos;s music under CC BY 4.0 (its credit line is added to the caption) and Kenney&apos;s CC0 sound
          effects. Pick music for a project or a slideshow where you make it.
        </p>
        <h3>Music</h3>
        <TrackList tracks={TRACKS.filter((track) => track.kind === "music")} />
        <h3>Sound effects</h3>
        <TrackList tracks={TRACKS.filter((track) => track.kind === "sfx")} />
      </Card>
    </>
  );
}

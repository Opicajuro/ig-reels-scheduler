import { Composition } from "remotion";
import { Captions } from "./Captions.jsx";

const FPS = 30;

export function Root() {
  return (
    <Composition
      id="Captions"
      component={Captions}
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={FPS}
      defaultProps={{ captions: [], durationSeconds: 1, preset: "classic", position: "bottom", uppercase: false }}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.durationSeconds * FPS) })}
    />
  );
}

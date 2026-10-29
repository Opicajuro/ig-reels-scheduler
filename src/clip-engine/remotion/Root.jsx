import { Still } from "remotion";
import { CaptionStill } from "./CaptionStill.jsx";

export function Root() {
  return (
    <Still
      id="CaptionStill"
      component={CaptionStill}
      width={1080}
      height={1920}
      defaultProps={{ words: [], highlight: null, preset: "classic", position: "bottom", uppercase: false }}
    />
  );
}

import { Still } from "remotion";
import { CaptionStill, EndCardStill, HookStill } from "./CaptionStill.jsx";

export function Root() {
  return (
    <>
      <Still
        id="CaptionStill"
        component={CaptionStill}
        width={1080}
        height={1920}
        defaultProps={{
          words: [],
          highlight: null,
          emoji: null,
          preset: "classic",
          position: "bottom",
          uppercase: false,
          font: "default",
          highlightColor: "yellow",
        }}
      />
      <Still id="HookStill" component={HookStill} width={1080} height={1920} defaultProps={{ text: "", font: "default" }} />
      <Still id="EndCardStill" component={EndCardStill} width={1080} height={1920} defaultProps={{ text: "", font: "default" }} />
    </>
  );
}

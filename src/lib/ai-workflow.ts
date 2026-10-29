import template from "./ai-workflow-wan22-ti2v-5b.json";

// The official ComfyUI example workflow for Wan 2.2 TI2V 5B (Comfy-Org/workflow_templates,
// templates/video_wan2_2_5B_ti2v.json at commit 14220b8), turned into the API format that ComfyUI's /prompt takes:
// node id → { class_type, inputs }. Its "__NAME__" strings are the values filled in here; everything else is the
// template's own setting (20 uni_pc steps, cfg 5, shift 8).

export type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
export type Workflow = Record<string, WorkflowNode>;

// Wan 2.2 5B makes 24 fps video at 720p; 704×1280 is its 720p size turned upright (9:16 within a few pixels).
export const AI_VIDEO_FPS = 24;
export const AI_VIDEO_WIDTH = 704;
export const AI_VIDEO_HEIGHT = 1280;
export const AI_VIDEO_SECONDS = [3, 5] as const;

// The nodes the worker talks about: the sampler reports the progress, SaveVideo writes the file, LoadImage is the
// optional start picture.
export const SAMPLER_NODE = "3";
export const OUTPUT_NODE = "58";
const START_IMAGE_NODE = "56";
const LATENT_NODE = "55";

// The template's own negative prompt (the one the Wan authors recommend), kept in Chinese as the model was trained.
export const NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

// The model takes 4n+1 frames; one second more than a whole number of seconds keeps the clip at full length.
export function framesFor(seconds: number): number {
  return seconds * AI_VIDEO_FPS + 1;
}

// A copy of the workflow with every placeholder filled. Without a start picture the LoadImage node and its link are
// left out, which makes it text-to-video.
export function fillWorkflow({
  prompt,
  seconds,
  startImage,
  seed,
}: {
  prompt: string;
  seconds: number;
  startImage: string | null;
  seed: number;
}): Workflow {
  const values: Record<string, unknown> = {
    __PROMPT__: prompt,
    __NEGATIVE_PROMPT__: NEGATIVE_PROMPT,
    __START_IMAGE__: startImage,
    __WIDTH__: AI_VIDEO_WIDTH,
    __HEIGHT__: AI_VIDEO_HEIGHT,
    __LENGTH__: framesFor(seconds),
    __SEED__: seed,
    __FPS__: AI_VIDEO_FPS,
  };
  const workflow = structuredClone(template) as Workflow;
  if (startImage === null) {
    delete workflow[START_IMAGE_NODE];
    delete workflow[LATENT_NODE].inputs.start_image;
  }
  for (const node of Object.values(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !/^__[A-Z_]+__$/.test(value)) continue;
      if (!(value in values)) throw new Error(`workflow placeholder ${value} has no value`);
      node.inputs[name] = values[value];
    }
  }
  return workflow;
}

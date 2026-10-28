import { describe, expect, it } from "vitest";
import { fillWorkflow, framesFor, NEGATIVE_PROMPT, OUTPUT_NODE, SAMPLER_NODE } from "./ai-workflow";

const base = { prompt: "A fox in the snow", seconds: 5, seed: 1234 };

describe("fillWorkflow", () => {
  it("fills the prompt, size, length, seed and frame rate of the Wan 2.2 5B workflow", () => {
    const workflow = fillWorkflow({ ...base, startImage: null });
    expect(workflow["6"].inputs.text).toBe("A fox in the snow");
    expect(workflow["7"].inputs.text).toBe(NEGATIVE_PROMPT);
    expect(workflow["55"].inputs).toMatchObject({ width: 704, height: 1280, length: 121, batch_size: 1 });
    expect(workflow[SAMPLER_NODE]).toMatchObject({ class_type: "KSampler", inputs: { seed: 1234, steps: 20, cfg: 5 } });
    expect(workflow["57"].inputs.fps).toBe(24);
    expect(workflow[OUTPUT_NODE].class_type).toBe("SaveVideo");
    expect(workflow["37"].inputs.unet_name).toBe("wan2.2_ti2v_5B_fp16.safetensors");
  });

  it("leaves no placeholder behind", () => {
    for (const startImage of [null, "start.png"]) {
      expect(JSON.stringify(fillWorkflow({ ...base, startImage }))).not.toMatch(/__[A-Z_]+__/);
    }
  });

  it("is text-to-video without a start picture: no LoadImage node and no link to it", () => {
    const workflow = fillWorkflow({ ...base, startImage: null });
    expect(Object.values(workflow).some((node) => node.class_type === "LoadImage")).toBe(false);
    expect(workflow["55"].inputs).not.toHaveProperty("start_image");
    // Every link points at a node that is there.
    for (const node of Object.values(workflow)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) expect(workflow).toHaveProperty(String(value[0]));
      }
    }
  });

  it("is image-to-video with a start picture", () => {
    const workflow = fillWorkflow({ ...base, startImage: "start.png" });
    expect(workflow["56"]).toEqual({ class_type: "LoadImage", inputs: { image: "start.png" } });
    expect(workflow["55"].inputs.start_image).toEqual(["56", 0]);
  });

  it("does not change the template between calls", () => {
    fillWorkflow({ ...base, startImage: null });
    expect(fillWorkflow({ ...base, startImage: "a.png" })["56"].inputs.image).toBe("a.png");
  });
});

describe("framesFor", () => {
  it("gives the 4n+1 frame counts the model takes", () => {
    for (const seconds of [2, 3, 5]) expect((framesFor(seconds) - 1) % 4).toBe(0);
    expect([framesFor(2), framesFor(3), framesFor(5)]).toEqual([49, 73, 121]);
  });
});

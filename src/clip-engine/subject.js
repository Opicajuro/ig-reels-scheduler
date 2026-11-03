// What a "Follow the action" crop follows in one sampled frame, in this order: faces (YuNet, OpenCV Zoo, MIT), else
// people or other main objects (YOLOX-nano, Megvii, Apache-2.0), else the centre of what moved since the last sample.
// Both models run through onnxruntime-node on the processor; their files ship with the installer (installer/tools.json)
// and setup writes their paths to .env as YUNET_MODEL and YOLOX_MODEL.
// A frame is { data, width, height }: BGR bytes, row by row, as ffmpeg's bgr24 gives them. A subject is { centre,
// left, right } as fractions of the frame's width: left and right span everything important, which may be wider than
// the crop.

// YuNet's 2023mar model has a fixed 640×640 input; YOLOX-nano's is 416×416.
export const FACE_INPUT = 640;
export const OBJECT_INPUT = 416;
const FACE_SCORE = 0.7;
const OBJECT_SCORE = 0.45;
const NMS_IOU = 0.45;
const STRIDES = [8, 16, 32];
// YOLOX's padding grey, as its own preprocessing pads.
const OBJECT_PAD = 114;
const COCO_PERSON = 0;
// Boxes at least this share of the main one's area count as important too.
const COMPANION_AREA = 0.5;
// A face is widened by this share of its width on each side, for the head and shoulders around it. A person or object
// counts by the middle half of its box, so one person with outstretched arms is still followed rather than fitted.
const FACE_MARGIN = 0.5;
const OBJECT_MARGIN = -0.25;
// A pixel moved when its brightness changed by more than this, and the frame moved when this share of it did.
const MOTION_THRESHOLD = 25;
const MOTION_SHARE = 0.002;

// The frame scaled by ratio into the top-left of a size×size input, as planar BGR floats with pad around it.
export function letterbox(frame, size, pad) {
  const ratio = Math.min(size / frame.width, size / frame.height);
  const width = Math.round(frame.width * ratio);
  const height = Math.round(frame.height * ratio);
  const plane = size * size;
  const tensor = new Float32Array(3 * plane).fill(pad);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.height - 1, Math.max(0, (y + 0.5) / ratio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(frame.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, Math.max(0, (x + 0.5) / ratio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(frame.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let channel = 0; channel < 3; channel++) {
        const at = (px, py) => frame.data[(py * frame.width + px) * 3 + channel];
        const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
        const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
        tensor[channel * plane + y * size + x] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { tensor, ratio };
}

const iou = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const overlap = w * h;
  return overlap / (a.w * a.h + b.w * b.h - overlap);
};

// The best-scoring boxes, without the ones that overlap a better box of the same label.
export function nonMaxSuppression(boxes, threshold = NMS_IOU) {
  const kept = [];
  for (const box of [...boxes].sort((a, b) => b.score - a.score)) {
    if (kept.every((other) => other.label !== box.label || iou(other, box) < threshold)) kept.push(box);
  }
  return kept;
}

// Faces from YuNet's outputs (cls_, obj_ and bbox_ per stride, by name), in input pixels, as OpenCV's FaceDetectorYN
// decodes them.
export function decodeYunet(outputs, size = FACE_INPUT, threshold = FACE_SCORE) {
  const boxes = [];
  for (const stride of STRIDES) {
    const cols = size / stride;
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    if (!cls || !obj || !bbox || cls.length !== cols * cols) throw new Error(`YuNet gave no stride ${stride} outputs`);
    for (let index = 0; index < cls.length; index++) {
      const clamp = (value) => Math.min(1, Math.max(0, value));
      const score = Math.sqrt(clamp(cls[index]) * clamp(obj[index]));
      if (score < threshold) continue;
      const col = index % cols;
      const row = Math.floor(index / cols);
      const cx = (col + bbox[index * 4]) * stride;
      const cy = (row + bbox[index * 4 + 1]) * stride;
      const w = Math.exp(bbox[index * 4 + 2]) * stride;
      const h = Math.exp(bbox[index * 4 + 3]) * stride;
      boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, label: 0 });
    }
  }
  return nonMaxSuppression(boxes);
}

// Objects from YOLOX's raw output ([anchors × (4 + 1 + classes)], undecoded), in input pixels, as YOLOX's ONNX demo
// decodes them: each anchor's grid cell and stride, its objectness times its best class score.
export function decodeYolox(output, size = OBJECT_INPUT, threshold = OBJECT_SCORE, classes = 80) {
  const stride = 5 + classes;
  const boxes = [];
  let anchor = 0;
  for (const step of STRIDES) {
    const cols = size / step;
    for (let cell = 0; cell < cols * cols; cell++, anchor++) {
      const at = anchor * stride;
      if (at + stride > output.length) throw new Error("YOLOX gave fewer anchors than its input size makes");
      let label = 0;
      for (let c = 1; c < classes; c++) if (output[at + 5 + c] > output[at + 5 + label]) label = c;
      const score = output[at + 4] * output[at + 5 + label];
      if (score < threshold) continue;
      const cx = (output[at] + (cell % cols)) * step;
      const cy = (output[at + 1] + Math.floor(cell / cols)) * step;
      const w = Math.exp(output[at + 2]) * step;
      const h = Math.exp(output[at + 3]) * step;
      boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, label });
    }
  }
  if (anchor * stride !== output.length) throw new Error("YOLOX gave more anchors than its input size makes");
  return nonMaxSuppression(boxes);
}

// The face and object detectors, each taking a frame and giving boxes in the frame's pixels.
/** @param {{ faceModel: string; objectModel: string }} models */
export async function loadDetectors({ faceModel, objectModel }) {
  const ort = await import("onnxruntime-node");
  const options = { executionProviders: ["cpu"] };
  const [face, object] = await Promise.all([
    ort.InferenceSession.create(faceModel, options),
    ort.InferenceSession.create(objectModel, options),
  ]);
  const run = async (session, frame, size, pad) => {
    const { tensor, ratio } = letterbox(frame, size, pad);
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", tensor, [1, 3, size, size]) });
    const data = Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, value.data]));
    return { data, ratio };
  };
  const scaled = (boxes, ratio) => boxes.map((box) => ({ ...box, x: box.x / ratio, y: box.y / ratio, w: box.w / ratio, h: box.h / ratio }));
  return {
    faces: async (frame) => {
      const { data, ratio } = await run(face, frame, FACE_INPUT, 0);
      return scaled(decodeYunet(data), ratio);
    },
    objects: async (frame) => {
      const { data, ratio } = await run(object, frame, OBJECT_INPUT, OBJECT_PAD);
      return scaled(decodeYolox(data[object.outputNames[0]]), ratio);
    },
  };
}

// The subject among boxes: the largest, most central one, and with it every box nearly as large, each widened by
// margin (a share of its width on each side; negative narrows it).
export function pickSubject(boxes, frameWidth, margin = 0) {
  if (boxes.length === 0) return null;
  const weight = (box) => box.w * box.h * (1 - 0.5 * Math.abs((box.x + box.w / 2) / frameWidth - 0.5) * 2);
  const main = boxes.reduce((best, box) => (weight(box) > weight(best) ? box : best));
  const important = boxes.filter((box) => box.w * box.h >= COMPANION_AREA * main.w * main.h);
  const clamp = (value) => Math.min(1, Math.max(0, value / frameWidth));
  const left = clamp(Math.min(...important.map((box) => box.x - box.w * margin)));
  const right = clamp(Math.max(...important.map((box) => box.x + box.w * (1 + margin))));
  return { centre: (left + right) / 2, left, right };
}

// A frame's brightness, one byte per pixel.
export function grayFrame(frame) {
  const gray = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (frame.data[i * 3] * 29 + frame.data[i * 3 + 1] * 150 + frame.data[i * 3 + 2] * 77) >> 8;
  }
  return gray;
}

// The centre of what moved between two brightness frames, as a point, or null when too little moved.
export function motionSubject(previous, current, width) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < current.length; i++) {
    if (Math.abs(current[i] - previous[i]) <= MOTION_THRESHOLD) continue;
    total++;
    sum += (i % width) + 0.5;
  }
  if (total < MOTION_SHARE * current.length) return null;
  const centre = sum / total / width;
  return { centre, left: centre, right: centre };
}

// The subject of one frame, in the documented order, with the frame's brightness for the next frame's motion.
// previous is the last frame's brightness, or null for the first frame.
export async function findSubject(frame, previous, detectors) {
  const gray = grayFrame(frame);
  const faces = await detectors.faces(frame);
  if (faces.length > 0) return { subject: { kind: "face", ...pickSubject(faces, frame.width, FACE_MARGIN) }, gray };
  const objects = await detectors.objects(frame);
  const people = objects.filter((box) => box.label === COCO_PERSON);
  if (objects.length > 0) {
    return { subject: { kind: "object", ...pickSubject(people.length > 0 ? people : objects, frame.width, OBJECT_MARGIN) }, gray };
  }
  const moved = previous ? motionSubject(previous, gray, frame.width) : null;
  return { subject: moved ? { kind: "motion", ...moved } : null, gray };
}

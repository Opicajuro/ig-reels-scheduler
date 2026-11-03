import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeYolox,
  decodeYunet,
  FACE_INPUT,
  findSubject,
  letterbox,
  motionSubject,
  OBJECT_INPUT,
  pickSubject,
} from "./subject.js";

// Recorded from the shipped models (installer/tools.json): YuNet on a 512×512 portrait and YOLOX-nano on a 548×342
// football photo (OpenCV's samples lena.jpg and messi5.jpg). Only the anchors that could pass are kept: YuNet's
// [index, cls, obj, 4 × bbox] per stride, YOLOX's [index, 4 × box, objectness, best class, its score].
const fixture = JSON.parse(readFileSync(new URL("./subject.fixture.json", import.meta.url), "utf8"));
const round = (box, ratio) => ({
  x: Math.round(box.x / ratio),
  y: Math.round(box.y / ratio),
  w: Math.round(box.w / ratio),
  h: Math.round(box.h / ratio),
  label: box.label,
});

test("decodeYunet finds the face in YuNet's recorded output", () => {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const cells = (FACE_INPUT / stride) ** 2;
    const cls = new Float32Array(cells);
    const obj = new Float32Array(cells);
    const bbox = new Float32Array(cells * 4);
    for (const [index, c, o, ...box] of fixture.yunet.anchors[stride]) {
      cls[index] = c;
      obj[index] = o;
      bbox.set(box, index * 4);
    }
    Object.assign(outputs, { [`cls_${stride}`]: cls, [`obj_${stride}`]: obj, [`bbox_${stride}`]: bbox });
  }
  const faces = decodeYunet(outputs).map((box) => round(box, fixture.yunet.ratio));
  assert.deepEqual(faces, [{ x: 210, y: 181, w: 142, h: 206, label: 0 }]);
  assert.throws(() => decodeYunet({ ...outputs, cls_8: new Float32Array(3) }), /no stride 8 outputs/);
});

test("decodeYolox finds the players and the ball in YOLOX-nano's recorded output", () => {
  const output = new Float32Array(3549 * 85);
  for (const [index, x, y, w, h, objectness, label, score] of fixture.yolox.anchors) {
    output.set([x, y, w, h, objectness], index * 85);
    output[index * 85 + 5 + label] = score;
  }
  const objects = decodeYolox(output, OBJECT_INPUT).map((box) => round(box, fixture.yolox.ratio));
  const ball = objects.filter((box) => box.label === 32);
  const people = objects.filter((box) => box.label === 0);
  assert.equal(ball.length, 1);
  assert.ok(Math.abs(ball[0].x + ball[0].w / 2 - 362) < 5, JSON.stringify(ball));
  assert.ok(people.length >= 3, JSON.stringify(people));
  // The largest person is the player in front.
  const main = people.reduce((best, box) => (box.w * box.h > best.w * best.h ? box : best));
  assert.ok(main.x > 40 && main.x + main.w < 520, JSON.stringify(main));
  assert.throws(() => decodeYolox(new Float32Array(85), OBJECT_INPUT), /fewer anchors/);
});

test("letterbox scales into the top-left corner and pads the rest", () => {
  const frame = { data: new Uint8Array(4 * 2 * 3).fill(200), width: 4, height: 2 };
  const { tensor, ratio } = letterbox(frame, 8, 114);
  assert.equal(ratio, 2);
  assert.equal(tensor.length, 3 * 64);
  assert.equal(tensor[0], 200);
  assert.equal(tensor[3 * 8 + 7], 200);
  assert.equal(tensor[4 * 8], 114);
  assert.equal(tensor[64 * 2 + 7 * 8 + 7], 114);
});

test("pickSubject centres on the largest, most central box and spans the ones nearly as large", () => {
  const box = (x, w) => ({ x, y: 0, w, h: w, score: 1, label: 0 });
  assert.equal(pickSubject([], 100), null);
  // A large face on the left and a small one on the right: only the large one counts.
  assert.deepEqual(pickSubject([box(10, 20), box(80, 5)], 100), { centre: 0.2, left: 0.1, right: 0.3 });
  // Two faces as large as each other far apart span both.
  assert.deepEqual(pickSubject([box(0, 10), box(90, 10)], 100), { centre: 0.5, left: 0, right: 1 });
  // A margin widens a face, and a negative one narrows a body to its middle.
  assert.deepEqual(pickSubject([box(40, 20)], 100, 0.5), { centre: 0.5, left: 0.3, right: 0.7 });
  assert.deepEqual(pickSubject([box(40, 20)], 100, -0.25), { centre: 0.5, left: 0.45, right: 0.55 });
});

test("motionSubject finds the centre of what changed, and nothing in a still frame", () => {
  const width = 100;
  const previous = new Uint8Array(width * 50);
  const current = previous.slice();
  for (let y = 10; y < 20; y++) for (let x = 70; x < 80; x++) current[y * width + x] = 255;
  assert.equal(motionSubject(previous, previous, width), null);
  assert.deepEqual(motionSubject(previous, current, width), { centre: 0.75, left: 0.75, right: 0.75 });
});

test("findSubject looks for faces, then people and objects, then motion", async () => {
  const frame = { data: new Uint8Array(100 * 50 * 3), width: 100, height: 50 };
  const moved = { ...frame, data: frame.data.slice() };
  for (let y = 0; y < 50; y++) for (let x = 0; x < 10; x++) moved.data.fill(255, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  const face = { x: 60, y: 10, w: 10, h: 10, score: 0.9, label: 0 };
  const person = { x: 20, y: 0, w: 20, h: 50, score: 0.9, label: 0 };
  const car = { x: 80, y: 0, w: 20, h: 20, score: 0.9, label: 2 };
  const calls = [];
  const detectors = (faces, objects) => ({
    faces: async () => (calls.push("faces"), faces),
    objects: async () => (calls.push("objects"), objects),
  });

  const still = (await findSubject(frame, null, detectors([], []))).gray;
  calls.length = 0;
  const byFace = await findSubject(moved, still, detectors([face], [person]));
  assert.equal(byFace.subject.kind, "face");
  assert.ok(Math.abs(byFace.subject.centre - 0.65) < 1e-9);
  assert.deepEqual(calls, ["faces"]);

  calls.length = 0;
  const byPerson = await findSubject(moved, still, detectors([], [car, person]));
  assert.equal(byPerson.subject.kind, "object");
  assert.ok(Math.abs(byPerson.subject.centre - 0.3) < 1e-9, "a person goes before a larger-looking car");
  assert.deepEqual(calls, ["faces", "objects"]);

  const byObject = await findSubject(moved, still, detectors([], [car]));
  assert.ok(Math.abs(byObject.subject.centre - 0.9) < 1e-9);

  const byMotion = await findSubject(moved, still, detectors([], []));
  assert.deepEqual(byMotion.subject, { kind: "motion", centre: 0.05, left: 0.05, right: 0.05 });
  assert.equal((await findSubject(moved, null, detectors([], []))).subject, null);
});

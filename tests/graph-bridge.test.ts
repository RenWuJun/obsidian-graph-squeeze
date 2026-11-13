import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphBridge, getGraphForces, type GraphRenderer } from "../src/graph-bridge";
import { adjustDistance, DEFAULT_SETTINGS, getBounds, normalizeSettings } from "../src/settings";
import { applyAreaForce, barrierForceAt } from "../src/area-force";
import { instrumentWorker } from "../src/worker-source";
import { timerWindow } from "./timer-window";

class FakeWorker {
  messages: any[] = [];
  received: any[] = [];
  onmessage: ((event: MessageEvent) => void) | null = event => this.received.push(event.data);
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  postMessage(message: unknown): void { this.messages.push(structuredClone(message)); }
  terminate(): void { this.terminated = true; }
  emit(data: unknown): void { this.onmessage?.(new MessageEvent("message", { data })); }
}
function setup(t: { after(fn: () => void): void }, ready = true) {
  const original = new FakeWorker();
  const simulation = new FakeWorker();
  const clock = timerWindow();
  const renderer: GraphRenderer = {
    containerEl: clock.containerEl,
    worker: original as unknown as Worker,
    nodes: [{ id: "a", x: 11, y: -500 }, { id: "b", x: -17, y: 600 }],
    links: [{ source: { id: "a" }, target: { id: "b" } }],
    changed() {},
  };
  const errors: unknown[] = [];
  const settings = { ...DEFAULT_SETTINGS, barrierDistance: 280 };
  const forces = { centerStrength: 0.2, repelStrength: 800, linkStrength: 0.5, linkDistance: 150 };
  const bridge = new GraphBridge(renderer, () => settings, error => errors.push(error),
    { createWorker: () => simulation as unknown as Worker, forces });
  if (ready) simulation.emit({ __graphSqueezeReady: true });
  t.after(() => bridge.detach(false));
  return { original, simulation, renderer, errors, settings, forces, bridge, clock };
}

test("worker startup timeout belongs to the graph window and is cleared on ready or detach", t => {
  const pending = setup(t, false);
  assert.equal(pending.clock.pending.size, 1);
  pending.simulation.emit({ __graphSqueezeReady: true });
  assert.equal(pending.clock.pending.size, 0);
  const closed = setup(t, false);
  closed.bridge.detach();
  assert.equal(closed.clock.pending.size, 0);
  const failed = setup(t, false);
  for (const callback of failed.clock.pending.values()) callback();
  assert.equal(failed.clock.pending.size, 0);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.simulation.terminated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(failed.original, "postMessage"), false);
});

test("malformed worker messages restore the ordinary graph without throwing", t => {
  for (const message of [null, 42, "bad", { __graphSqueezeReady: "yes" }, { ignore: "yes" }]) {
    const { simulation, errors, original } = setup(t);
    assert.doesNotThrow(() => simulation.emit(message));
    assert.equal(errors.length, 1);
    assert.equal(simulation.terminated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(original, "postMessage"), false);
  }
});

test("areas change only vertical velocity and always push inward beyond their boundaries", () => {
  const nodes = [
    { x: 3, y: -300, vx: 4, vy: -20 },
    { x: 5, y: 300, vx: 6, vy: 20 },
    { x: 7, y: 0, vx: 8, vy: 0 },
  ];
  const before = structuredClone(nodes);
  assert.equal(applyAreaForce(nodes, 200), true);
  assert.ok(nodes[0].vy > before[0].vy);
  assert.ok(nodes[1].vy < before[1].vy);
  assert.equal(nodes[2].vy, 0);
  for (let i = 0; i < nodes.length; i++) {
    assert.equal(nodes[i].x, before[i].x);
    assert.equal(nodes[i].y, before[i].y);
    assert.equal(nodes[i].vx, before[i].vx);
  }
});

test("squeeze force cools with native repulsion instead of crushing settled nodes", () => {
  const initial = { y: 1100, vy: 100 };
  const full = { ...initial };
  applyAreaForce([full], 2000, 250, 1);
  for (const alpha of [0.3, 0.01, 0.001, 0]) {
    const cooled = { ...initial };
    const changed = applyAreaForce([cooled], 2000, 250, alpha);
    assert.ok(Math.abs((cooled.vy - initial.vy) - (full.vy - initial.vy) * alpha) < 1e-10);
    assert.equal(changed, alpha > 0);
    assert.equal(cooled.y, initial.y);
  }
});

test("force grows across the soft edge and acts at arbitrarily distant horizontal positions", () => {
  const near = { x: 1e9, y: -110, vy: 0 };
  const far = { x: -1e9, y: -1000, vy: 0 };
  applyAreaForce([near, far], 2000, 1000);
  assert.ok(far.vy > near.vy && near.vy > 0);
  const below = { y: 1000, vy: 0 };
  applyAreaForce([below], 2000, 1000);
  assert.equal(below.vy, -far.vy);
});

test("pinning during a drag is respected; releasing activates the directional force", () => {
  const node = { y: -500, vy: 0, fy: -500 as number | null };
  assert.equal(applyAreaForce([node], 200), false);
  assert.equal(node.vy, 0);
  node.fy = null;
  assert.equal(applyAreaForce([node], 200), true);
  assert.ok(node.vy > 0);
});

test("zero gap pushes toward the center; inside a nonzero band there is no area force", () => {
  const upper = { y: -1, vy: 0 };
  const lower = { y: 1, vy: 0 };
  assert.equal(applyAreaForce([upper, lower], 0), true);
  assert.ok(upper.vy > 0 && lower.vy < 0);
  assert.equal(applyAreaForce([{ y: 0, vy: 0 }, { y: 99, vy: 0 }, { y: -100, vy: 0 }], 200), false);
});

test("soft edges span the full approach zone and stay at maximum beyond the boundary", () => {
  const magnitudes: number[] = [];
  for (const y of [750, 800, 900, 1000, 1100]) {
    const lower = { y, vy: 0 };
    const upper = { y: -y, vy: 0 };
    applyAreaForce([lower, upper], 2000, 250);
    assert.equal(lower.vy + upper.vy, 0);
    magnitudes.push(Math.abs(lower.vy));
  }
  assert.equal(magnitudes[0], 0);
  for (let i = 1; i < 4; i++) assert.ok(magnitudes[i] > magnitudes[i - 1]);
  assert.equal(magnitudes[3], 10);
  assert.equal(magnitudes[4], 10);
  assert.ok(magnitudes[1] < magnitudes[3] / 8, "The start of the ramp must be gentle");
});

test("10,000 softness spans exactly 10,000 units independently of maximum force", () => {
  for (const maximum of [1, 20, 100, 1000]) for (const sign of [-1, 1]) {
    for (const [y, fraction] of [[10000, 0], [12500, 0.15625], [15000, 0.5], [17500, 0.84375], [20000, 1], [25000, 1]]) {
      assert.equal(barrierForceAt(sign * y, 40000, 10000, maximum), maximum * fraction);
    }
    assert.ok(barrierForceAt(sign * 12000, 40000, 10000, maximum) < maximum * 0.11,
      "Two thousand units into the ramp must not already be near maximum");
    assert.equal(barrierForceAt(sign * 500, 2000, 10000, maximum), maximum * 0.5,
      "An oversized softness value is still limited to half the gap");
  }
});

test("force is continuous at the ramp start and the boundary", () => {
  const epsilon = 1e-6;
  for (const edge of [750, 1000]) {
    const before = { y: edge - epsilon, vy: 100 };
    const at = { y: edge, vy: 100 };
    const after = { y: edge + epsilon, vy: 100 };
    applyAreaForce([before, at, after], 2000, 250);
    assert.ok(Math.abs(before.vy - at.vy) < 1e-4);
    assert.ok(Math.abs(after.vy - at.vy) < 1e-4);
  }
  const at = { y: 1000, vy: 100 };
  const beyond = { y: 1000 + epsilon, vy: 100 };
  applyAreaForce([at, beyond], 2000, 0);
  assert.equal(at.vy, 100);
  assert.equal(beyond.vy, 90, "Zero softness means an immediate full-strength push beyond the boundary");
});

test("softness is capped at half the gap, leaves the center neutral and remains finite at zero", () => {
  for (const gap of [0, 1, 200]) {
    const nodes = [{ y: 0, vy: 0 }, { y: -10, vy: 0 }, { y: 10, vy: 0 }];
    applyAreaForce(nodes, gap, 20_000);
    assert.equal(nodes[0].vy, 0);
    for (const node of nodes) assert.ok(Number.isFinite(node.vy));
    assert.equal(nodes[1].vy, -nodes[2].vy);
  }
});

test("maximum force bounds the entire push, supports zero and preserves a smooth approach to the limit", () => {
  for (const maximum of [0, 1, 20, 100, 1000]) for (const alpha of [1, 0.3, 0.001]) {
    for (const y of [-1e9, -1100, 0, 1100, 1e9]) {
      const node = { y, vy: 1000 };
      applyAreaForce([node], 2000, 250, alpha, maximum);
      assert.ok(Math.abs(node.vy - 1000) <= maximum * alpha + 1e-10);
      if (maximum === 0) assert.equal(node.vy, 1000);
    }
  }
  const stationary = { y: 1100, vy: 0 };
  const moving = { y: 1100, vy: 1000 };
  applyAreaForce([stationary, moving], 2000, 250, 1, 100);
  assert.ok(Math.abs(stationary.vy - (moving.vy - 1000)) < 1e-10, "No extra velocity-dependent correction");
  for (const y of [750, 1000]) {
    const e = 0.001;
    const left = (barrierForceAt(y, 2000, 250, 100) - barrierForceAt(y - e, 2000, 250, 100)) / e;
    const right = (barrierForceAt(y + e, 2000, 250, 100) - barrierForceAt(y, 2000, 250, 100)) / e;
    assert.ok(Math.abs(left - right) < 1e-5, "No slope jump at either end of the soft edge");
  }
  assert.ok(barrierForceAt(2000, 2000, 250, 20) < barrierForceAt(2000, 2000, 250, 100));
  assert.ok(barrierForceAt(2000, 2000, 250, 100) === 100, "Stay at full strength beyond the boundary");
});

test("maximum force is normalized and reaches the live worker without moving boundaries", t => {
  assert.equal(normalizeSettings({}).maxForce, 10);
  assert.equal(normalizeSettings({ maxForce: NaN }).maxForce, 10);
  assert.equal(normalizeSettings({ maxForce: -10 }).maxForce, 0);
  assert.equal(normalizeSettings({ maxForce: 5000 }).maxForce, 1000);
  const { simulation, settings, bridge } = setup(t);
  const bounds = getBounds(settings);
  settings.maxForce = 20;
  simulation.messages = [];
  bridge.reheat();
  assert.deepEqual(simulation.messages, [
    { __graphSqueeze: { gap: 280, edgeSoftness: 10000, maxForce: 20 } }, { alpha: 0.3, run: true },
  ]);
  assert.deepEqual(getBounds(settings), bounds);
});

test("starts the enhanced native worker with exact real nodes, links, force settings and gap", t => {
  const { simulation, forces } = setup(t);
  assert.deepEqual(simulation.messages[0], { __graphSqueeze: { gap: 280, edgeSoftness: 10000, maxForce: 10 } });
  const initial = simulation.messages[1];
  assert.deepEqual(initial.nodes, { a: [11, -500], b: [-17, 600] });
  assert.deepEqual(initial.links, [["a", "b"]]);
  assert.deepEqual(initial.forces, forces);
  assert.equal(Object.keys(initial.nodes).length, 2, "No fake nodes");
});

test("routes drag and force messages without changing their parameters or field boundaries", t => {
  const { original, simulation, settings } = setup(t);
  const message = { forces: { repelStrength: 8000 }, alpha: 0.3, run: true };
  original.postMessage(message);
  assert.deepEqual(simulation.messages.slice(-1)[0], message);
  assert.deepEqual(original.messages.slice(-1)[0], { forces: { repelStrength: 8000 } });
  const drag = { forceNode: { id: "a", x: 90, y: -30_000 }, alphaTarget: 0.3 };
  original.postMessage(drag);
  assert.deepEqual(simulation.messages.slice(-1)[0], drag);
  assert.equal(settings.barrierDistance, 280);
  assert.equal(simulation.messages.filter(message => message.__graphSqueeze).length, 1);
});

test("passes simulated output through unchanged, including shared buffers; ignores original output", t => {
  const { original, simulation } = setup(t);
  const buffer = new SharedArrayBuffer(20);
  new Float32Array(buffer, 0, 4).set([11, -450, -17, 550]);
  new Uint32Array(buffer, 16, 1)[0] = 8;
  original.emit({ id: ["a", "b"], buffer: new Float32Array([0, 999, 0, 999]).buffer });
  assert.equal(original.received.length, 0);
  const data = { id: ["a", "b"], buffer, v: 7 };
  simulation.emit(data);
  assert.equal(original.received[0], data);
  assert.deepEqual([...new Float32Array(buffer, 0, 4)], [11, -450, -17, 550]);
  assert.equal(new Uint32Array(buffer, 16, 1)[0], 8);
});

test("filtering forwards exact topology and drops old frames without resurrecting removed notes", t => {
  const { original, simulation, bridge } = setup(t);
  original.postMessage({ nodes: { b: null, c: [1, 2] }, links: [["b", "c"]], run: true });
  simulation.emit({ id: ["a", "b"], buffer: new Float32Array([0, -500, 0, 600]).buffer });
  assert.equal(original.received.length, 0);
  simulation.emit({ id: ["b", "c"], buffer: new Float32Array([3, 4, 5, 6]).buffer });
  bridge.detach();
  assert.deepEqual(original.messages.slice(-1)[0].nodes, { b: [3, 4], c: [5, 6] });
});

test("changing distance sends only a new field configuration and reheat", t => {
  const { original, simulation, settings, bridge } = setup(t);
  original.messages = [];
  simulation.messages = [];
  settings.barrierDistance = 0;
  bridge.reheat();
  assert.deepEqual(simulation.messages, [{ __graphSqueeze: { gap: 0, edgeSoftness: 10000, maxForce: 10 } }, { alpha: 0.3, run: true }]);
  assert.deepEqual(original.messages, []);
});

test("softness changes reach the worker without moving either boundary", t => {
  const { simulation, settings, bridge } = setup(t);
  const bounds = getBounds(settings);
  simulation.messages = [];
  settings.edgeSoftness = 75;
  bridge.reheat();
  assert.deepEqual(simulation.messages, [
    { __graphSqueeze: { gap: 280, edgeSoftness: 75, maxForce: 10 } }, { alpha: 0.3, run: true },
  ]);
  assert.deepEqual(getBounds(settings), bounds);
});

test("disabling terminates the enhanced worker and restores native methods and last positions", t => {
  const { original, simulation, bridge } = setup(t);
  simulation.emit({ id: ["a", "b"], buffer: new Float32Array([1, -140, 2, 140]).buffer });
  bridge.detach();
  assert.equal(simulation.terminated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(original, "postMessage"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(original, "terminate"), false);
  assert.deepEqual(original.messages.slice(-1)[0], {
    nodes: { a: [1, -140], b: [2, 140] }, alphaTarget: 0, alpha: 0.3, run: true,
  });
  original.emit({ id: ["a", "b"], buffer: new Float32Array([1, -900, 2, 900]).buffer });
  assert.equal(original.received.length, 2);
});

test("closing a graph terminates both workers", t => {
  const { original, simulation } = setup(t);
  original.terminate();
  assert.equal(original.terminated, true);
  assert.equal(simulation.terminated, true);
});

test("worker errors restore the original graph and are reported once", t => {
  const { original, simulation, errors } = setup(t);
  simulation.onerror?.({ message: "test failure", preventDefault() {} });
  assert.equal(simulation.terminated, true);
  assert.equal(errors.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(original, "postMessage"), false);
});

test("cleanup preserves later wrappers installed by another plugin", t => {
  const { original, bridge } = setup(t);
  const post = original.postMessage;
  const receive = original.onmessage;
  const outerPost = (message: unknown) => post(message);
  const outerReceive = (event: MessageEvent) => receive?.(event);
  original.postMessage = outerPost;
  original.onmessage = outerReceive;
  bridge.detach(false);
  assert.equal(original.postMessage, outerPost);
  assert.equal(original.onmessage, outerReceive);
  original.messages = [];
  original.postMessage({ run: true });
  assert.deepEqual(original.messages, [{ run: true }]);
  original.emit({ test: true });
  assert.deepEqual(original.received, [{ test: true }]);
});

test("initial native slider values are converted to the existing worker force scale", () => {
  const forces = getGraphForces({ dataEngine: { getOptions: () => ({
    centerStrength: 0, linkStrength: 1, repelStrength: 10, linkDistance: 333,
  }) } });
  assert.deepEqual(forces, { centerStrength: 0, linkStrength: 1, repelStrength: 1000, linkDistance: 333 });
});

test("unrecognized or ambiguous native source fails closed", () => {
  assert.throws(() => instrumentWorker("self.onmessage = () => {};"), /unsupported physics layout/);
});

test("legacy settings migrate to one fixed gap and commands can leave zero", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    barrierDistance: 80000, edgeSoftness: 10000, maxForce: 10, showForceVisualizer: false,
  });
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(getBounds(DEFAULT_SETTINGS), { top: -40000, bottom: 40000 });
  assert.equal(normalizeSettings({ edgeSoftness: 40000 }).edgeSoftness, 40000);
  const saved = { barrierDistance: 40000, edgeSoftness: 1000, maxForce: 100, showForceVisualizer: true };
  assert.deepEqual(normalizeSettings(saved), saved, "New defaults must preserve explicit saved values");
  const migrated = normalizeSettings({ topDistance: 20_000, bottomDistance: 10_000, padding: 75 });
  assert.deepEqual(migrated, { barrierDistance: 29_850, edgeSoftness: 10000, maxForce: 10, showForceVisualizer: false });
  assert.deepEqual(normalizeSettings(migrated), migrated);
  assert.deepEqual(getBounds(migrated), { top: -14_925, bottom: 14_925 });
  for (const value of [0, 1, 200, 20_000, 40_000, 80_000]) {
    const settings = normalizeSettings({ barrierDistance: value });
    const bounds = getBounds(settings);
    assert.equal(bounds.bottom - bounds.top, value);
  }
  assert.equal(normalizeSettings({ barrierDistance: -100 }).barrierDistance, 0);
  assert.equal(normalizeSettings({ barrierDistance: 90_000 }).barrierDistance, 80_000);
  assert.deepEqual(normalizeSettings({ barrierDistance: NaN }), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ edgeSoftness: -1 }).edgeSoftness, 0);
  assert.equal(normalizeSettings({ edgeSoftness: 99999 }).edgeSoftness, 40_000);
  assert.equal(normalizeSettings({ edgeSoftness: 0 }).edgeSoftness, 0);
  assert.equal(normalizeSettings({ edgeSoftness: NaN }).edgeSoftness, 10000);
  assert.equal(adjustDistance(0, 1.25), 1);
  assert.equal(adjustDistance(1, 0.8), 0);
  assert.equal(adjustDistance(80_000, 1.25), 80_000);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { GraphBridge, type GraphRenderer } from "../src/graph-bridge";
import { instrumentWorker } from "../src/worker-source";
import { DEFAULT_SETTINGS } from "../src/settings";

// Use the user's installed sim.js; do not redistribute Obsidian's source.
const sourcePath = process.env.OBSIDIAN_SIM_PATH;
const defaultForces = { centerStrength: 0.1, repelStrength: 1000, linkStrength: 1, linkDistance: 250 };

class NativeWorker {
  context: vm.Context;
  timers: (() => void)[] = [];
  incoming: any[] = [];
  outgoing: any[] = [];
  frames: any[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  kicks = 0;
  constructor(source: string, wasm: boolean, shared: boolean) {
    this.context = vm.createContext({
      console: { log() {} }, atob,
      WebAssembly: wasm ? WebAssembly : undefined,
      SharedArrayBuffer: shared ? SharedArrayBuffer : undefined,
      setTimeout: (callback: () => void) => { this.timers.push(callback); return this.timers.length; },
      postMessage: (data: any) => {
        const frame = structuredClone(data);
        if (frame.id) this.frames.push(frame);
        this.outgoing.push(frame);
      },
    });
    this.context.self = this.context;
    vm.runInContext(source, this.context, { timeout: 10000 });
    if (this.context.__graphSqueezeApply) {
      const apply = this.context.__graphSqueezeApply;
      this.context.__graphSqueezeApply = (nodes: any[], alpha: number) => {
        const before = nodes.map(node => ({ x: node.x, y: node.y, vx: node.vx, vy: node.vy }));
        assert.ok(Number.isFinite(alpha) && alpha > 0 && alpha <= 1, "The field must receive native cooling");
        const changed = apply(nodes, alpha);
        nodes.forEach((node, index) => {
          const old = before[index];
          assert.equal(node.x, old.x);
          assert.equal(node.y, old.y);
          assert.ok(Number.isFinite(node.vx) && Number.isFinite(node.vy));
          assert.equal(node.vx, old.vx, "Only the vertical barrier force may be added");
          assert.ok(Math.abs(node.vy - old.vy) <= this.context.__graphSqueezeMaxForce * alpha + 1e-8);
          if (node.vy !== old.vy) assert.ok((node.vy - old.vy) * old.y < 0, "Always push inward");
          if (node.vy !== old.vy || node.vx !== old.vx) {
            this.kicks++;
          }
        });
        return changed;
      };
    }
  }
  postMessage(message: unknown): void { this.incoming.push(structuredClone(message)); }
  terminate(): void { this.terminated = true; this.timers = []; }
  step(): boolean {
    if (this.terminated) return false;
    while (this.incoming.length) this.context.onmessage({ data: this.incoming.shift() });
    const tick = this.timers.shift();
    if (tick) tick();
    while (this.outgoing.length) {
      const data = this.outgoing.shift();
      this.onmessage?.(new MessageEvent("message", { data }));
    }
    return !!tick;
  }
}

for (const wasm of [true, false]) for (const shared of [true, false]) {
  test(`native directional areas: recovery, fixed bounds and cleanup (WASM=${wasm}, shared=${shared})`,
    { skip: !sourcePath }, t => {
      const source = readFileSync(sourcePath!, "utf8");
      const extended = instrumentWorker(source);
      assert.throws(() => instrumentWorker(source + source), /unsupported physics layout/);
      // With every node inside a wide band, native physics must be unchanged.
      const untouched = new NativeWorker(source, wasm, shared);
      const wide = new NativeWorker(extended, wasm, shared);
      assert.equal(wide.context.__graphSqueezeGap, 80000);
      assert.equal(wide.context.__graphSqueezeSoftness, 10000);
      assert.equal(wide.context.__graphSqueezeMaxForce, 10);
      const smallGraph = { nodes: { a: [-50, -10], b: [0, 0], c: [50, 10] },
        links: [["a", "b"], ["b", "c"]], forces: defaultForces, alpha: 0.3, run: true };
      untouched.postMessage(smallGraph);
      wide.postMessage(smallGraph);
      for (let i = 0; i < 30; i++) {
        untouched.step();
        wide.step();
        const first = untouched.frames[untouched.frames.length - 1];
        const second = wide.frames[wide.frames.length - 1];
        assert.deepEqual([...new Float32Array(first.buffer)], [...new Float32Array(second.buffer)]);
      }
      assert.equal(wide.kicks, 0);
      // Zero maximum disables all added physics even when every note lies in an
      // active area. Native positions must stay bit-for-bit unchanged.
      wide.postMessage({ __graphSqueeze: { gap: 0, maxForce: 0 } });
      for (let i = 0; i < 30; i++) {
        untouched.step(); wide.step();
        assert.deepEqual([...new Float32Array(untouched.frames[untouched.frames.length - 1].buffer)],
          [...new Float32Array(wide.frames[wide.frames.length - 1].buffer)]);
      }
      assert.equal(wide.kicks, 0);
      for (const maximum of [20, 300]) {
        wide.postMessage({ __graphSqueeze: { maxForce: maximum } });
        wide.step();
        const probe = { x: 0, y: 1e6, vx: 0, vy: 0 };
        wide.context.__graphSqueezeApply([probe], 0.3);
        assert.equal(probe.vy, -maximum * 0.3, "Live maximum setting controls the actual worker force");
        assert.equal(wide.context.__graphSqueezeGap, 0);
      }
      for (const maximum of [20, 300]) {
        wide.postMessage({ __graphSqueeze: { gap: 40000, edgeSoftness: 10000, maxForce: maximum } });
        wide.step();
        for (const [y, fraction] of [[10000, 0], [15000, 0.5], [20000, 1]]) {
          const probe = { x: 0, y, vx: 0, vy: 0 };
          wide.context.__graphSqueezeApply([probe], 0.3);
          assert.equal(Math.abs(probe.vy), maximum * fraction * 0.3,
            "The embedded worker must honor the full ramp at every maximum");
        }
      }
      // Closing the gap increases the force on the same positions. A final
      // graph's bounding box also depends on topology and which layout settles,
      // so it is not a reliable measure of this local force contract.
      const responses: number[][] = [];
      for (const gap of [280, 0]) {
        wide.postMessage({ __graphSqueeze: { gap, edgeSoftness: 1000, maxForce: 100 } });
        wide.step();
        responses.push([-300, -70, 0, 70, 300].map(y => {
          const probe = { x: 0, y, vx: 0, vy: 0 };
          wide.context.__graphSqueezeApply([probe], 0.3);
          return Math.abs(probe.vy);
        }));
      }
      assert.ok(responses[1].every((force, i) => force >= responses[0][i]));
      assert.ok(responses[1][1] > responses[0][1]);
      wide.postMessage({ __graphSqueeze: { gap: 80000, edgeSoftness: 40000, maxForce: 10 } });
      wide.step();
      assert.equal(wide.context.__graphSqueezeGap, 80000, "Do not clamp to the old gap limit");
      assert.equal(wide.context.__graphSqueezeSoftness, 40000, "Do not clamp to the old softness limit");
      for (const [y, expected] of [[0, 0], [20000, 5], [40000, 10]]) {
        const probe = { x: 0, y, vx: 0, vy: 0 };
        wide.context.__graphSqueezeApply([probe], 1);
        assert.equal(Math.abs(probe.vy), expected);
      }
      untouched.terminate();
      wide.terminate();
      // Updating the real repel slider on an already settled worker must refresh
      // the JS force cache as well as the WASM values. Isolate repulsion from links.
      const responsive = new NativeWorker(extended, wasm, shared);
      const repelNodes: Record<string, [number, number]> = {};
      for (let i = 0; i < 60; i++) {
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        repelNodes[`r${i}`] = [Math.cos(angle) * 30 * Math.sqrt(i + 1), Math.sin(angle) * 30 * Math.sqrt(i + 1)];
      }
      responsive.postMessage({ nodes: repelNodes, links: [],
        forces: { ...defaultForces, repelStrength: 100 }, alpha: 0.3, run: true });
      for (let i = 0; i < 350 && responsive.step(); i++) { /* Settle low repel. */ }
      const extent = () => {
        const frame = responsive.frames[responsive.frames.length - 1];
        const points = new Float32Array(frame.buffer, 0, frame.id.length * 2);
        const xs = [...points].filter((_, i) => i % 2 === 0);
        return Math.max(...xs) - Math.min(...xs);
      };
      const lowRepelWidth = extent();
      responsive.postMessage({ forces: { repelStrength: 8000 }, alpha: 0.3, run: true });
      for (let i = 0; i < 350 && responsive.step(); i++) { /* Settle high repel. */ }
      assert.equal(responsive.context.__graphSqueezeMaxForce, 10);
      assert.ok(extent() > lowRepelWidth * 1.8, "The live repel control must increase separation");
      responsive.terminate();
      // A dragged note can be held far outside; after release the same native
      // worker must bring it inward without any position correction messages.
      const drag = new NativeWorker(extended, wasm, shared);
      drag.postMessage({ __graphSqueeze: { gap: 280, edgeSoftness: 1000, maxForce: 100 } });
      drag.postMessage({ nodes: { a: [0, -20_000], b: [100, 20_000] }, links: [],
        forces: defaultForces, alpha: 0.3, run: true });
      drag.postMessage({ forceNode: { id: "a", x: 0, y: -20_000 } });
      for (let i = 0; i < 20; i++) drag.step();
      let dragged = drag.frames[drag.frames.length - 1];
      assert.equal(new Float32Array(dragged.buffer)[dragged.id.indexOf("a") * 2 + 1], -20_000);
      drag.postMessage({ forceNode: { id: "a", x: null, y: null }, alpha: 0.3, run: true });
      for (let i = 0; i < 300 && drag.step(); i++) { /* Settle after release. */ }
      dragged = drag.frames[drag.frames.length - 1];
      for (let i = 0; i < 2; i++) assert.ok(Math.abs(new Float32Array(dragged.buffer)[i * 2 + 1]) < 160);
      assert.ok(drag.kicks > 0);
      drag.terminate();
      function simulate(gap: number | null, stress = false, repelStrength = 1000, maxForce = 100) {
        const original = new NativeWorker(source, wasm, shared);
        const enhanced = gap === null ? undefined : new NativeWorker(extended, wasm, shared);
        let result: any;
        const active = enhanced ?? original;
        original.onmessage = event => {
          if (event.data.ignore) return;
          result = event.data;
          const raw = active.frames[active.frames.length - 1];
          assert.deepEqual(result.id, raw.id);
          assert.deepEqual([...new Float32Array(result.buffer)], [...new Float32Array(raw.buffer)]);
        };
        const nodes: Record<string, [number, number]> = {};
        const links: [string, string][] = [];
        for (let i = 0; i < 180; i++) {
          const angle = i * Math.PI * (3 - Math.sqrt(5));
          const radius = 30 * Math.sqrt(i + 1);
          nodes[`n${i}`] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
          if (i > 0) links.push([`n${i}`, `n${Math.floor((i - 1) / 2)}`]);
        }
        const forces = { ...defaultForces, repelStrength };
        original.postMessage({ nodes, links, forces, alpha: 0.3, run: true });
        const renderer: GraphRenderer = {
          worker: original as unknown as Worker,
          nodes: Object.entries(nodes).map(([id, [x, y]]) => ({ id, x, y })),
          links: links.map(([source, target]) => ({ source: { id: source }, target: { id: target } })),
          changed() {},
        };
        const settings = { ...DEFAULT_SETTINGS, barrierDistance: gap ?? DEFAULT_SETTINGS.barrierDistance, edgeSoftness: 1000, maxForce };
        const errors: unknown[] = [];
        const bridge = enhanced ? new GraphBridge(renderer, () => settings, error => errors.push(error),
          { createWorker: () => enhanced as unknown as Worker, forces }) : undefined;
        t.after(() => { bridge?.detach(false); original.terminate(); enhanced?.terminate(); });
        let frames = 0;
        for (let i = 0; i < 1000; i++) {
          if (stress && [20, 60, 100].includes(i)) {
            const forces = i === 60
              ? { repelStrength: 8000, centerStrength: 0.9, linkStrength: 0.2, linkDistance: 500 }
              : defaultForces;
            original.postMessage({ forces, alpha: 0.3, run: true });
          }
          const first = original.step();
          const second = enhanced?.step();
          if (enhanced) {
            assert.equal(enhanced.context.__graphSqueezeMaxForce, maxForce);
            assert.equal(enhanced.context.__graphSqueezeGap, gap,
              "Native force sliders must not move the area boundaries");
            assert.equal(enhanced.context.__graphSqueezeSoftness, settings.edgeSoftness,
              "Native force sliders must not change the edge softness");
          }
          if (!first && !second) break;
          frames++;
        }
        assert.ok(frames < 1000, "The simulation must cool normally");
        assert.deepEqual(errors, []);
        assert.equal(result.id.length, 180, "No extra invisible nodes");
        const positions = [...new Float32Array(result.buffer, 0, 360)];
        const xs = positions.filter((_, i) => i % 2 === 0);
        const ys = positions.filter((_, i) => i % 2 === 1);
        const nearest = xs.map((x, i) => {
          let distance = Infinity;
          for (let j = 0; j < xs.length; j++) if (i !== j) {
            distance = Math.min(distance, Math.hypot(x - xs[j], ys[i] - ys[j]));
          }
          return distance;
        }).sort((a, b) => a - b);
        if (enhanced) {
          assert.ok(enhanced.kicks > 100, "The areas must apply real velocity forces");
          bridge!.detach();
          assert.equal(enhanced.terminated, true);
          const restoration = original.incoming[original.incoming.length - 1];
          result.id.forEach((id: string, i: number) =>
            assert.deepEqual(restoration.nodes[id], [positions[i * 2], positions[i * 2 + 1]]));
          assert.deepEqual(original.incoming[original.incoming.length - 1].alphaTarget, 0);
        }
        return { width: Math.max(...xs) - Math.min(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
          medianSpacing: nearest[Math.floor(nearest.length / 2)],
          closePairs: nearest.filter(distance => distance < 60).length };
      }
      const normal = simulate(null);
      const squeezed = simulate(280);
      const weak = simulate(280, false, 1000, 20);
      const strong = simulate(280, false, 1000, 1000);
      const closed = simulate(0);
      const stressed = simulate(0, true);
      const lowRepel = simulate(280, false, 100);
      const highRepel = simulate(280, false, 8000);
      assert.ok(squeezed.maxY - squeezed.minY < (normal.maxY - normal.minY) * 0.8,
        `Squeeze must flatten the graph while allowing repulsion: ${JSON.stringify(squeezed)}`);
      assert.ok(squeezed.width > normal.width * 1.1,
        `Expected horizontal spreading: ${JSON.stringify({ normal, squeezed })}`);
      assert.ok(closed.maxY - closed.minY < (normal.maxY - normal.minY) * 0.8,
        `Zero gap should still flatten the graph: ${JSON.stringify(closed)}`);
      assert.ok(stressed.maxY - stressed.minY < (normal.maxY - normal.minY) * 0.8,
        "The graph must remain a broad band after live force changes");
      assert.ok(squeezed.medianSpacing >= normal.medianSpacing * 0.9,
        `Squeezing must preserve typical node separation: ${JSON.stringify({ normal, squeezed })}`);
      assert.equal(squeezed.closePairs, 0, "Do not crush nodes inside another node's collision radius");
      assert.ok(strong.maxY - strong.minY < (weak.maxY - weak.minY) * 0.85,
        `Higher maximum force must squeeze harder: ${JSON.stringify({ weak, strong })}`);
      assert.ok(highRepel.width > lowRepel.width * 1.8 && highRepel.medianSpacing > lowRepel.medianSpacing * 1.1,
        "Increasing repel while squeezed must spread nodes farther apart");
      console.log(`Native ${wasm ? "WASM" : "JS"}/${shared ? "shared" : "transfer"}: ` +
        `width ${normal.width.toFixed(0)} → ${squeezed.width.toFixed(0)}, ` +
        `height ${(normal.maxY - normal.minY).toFixed(0)} → ${(squeezed.maxY - squeezed.minY).toFixed(0)}, ` +
        `nearest-neighbor spacing ${normal.medianSpacing.toFixed(0)} → ${squeezed.medianSpacing.toFixed(0)}`);
    });
}

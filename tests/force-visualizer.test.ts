import assert from "node:assert/strict";
import { test } from "node:test";
import { forceOpacity, forceGradient, ForceVisualizer } from "../src/force-visualizer";
import { applyAreaForce } from "../src/area-force";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";
import type { GraphRenderer } from "../src/graph-bridge";

test("visualizer is opt-in for new, existing and malformed settings", () => {
  assert.equal(DEFAULT_SETTINGS.showForceVisualizer, false);
  for (const value of [undefined, false, "true", 1, null]) {
    assert.equal(normalizeSettings({ showForceVisualizer: value }).showForceVisualizer, false);
  }
  assert.equal(normalizeSettings({ showForceVisualizer: true }).showForceVisualizer, true);
});

test("opacity follows actual barrier pressure, including zero gap and zero softness", () => {
  for (const gap of [0, 2000, 40000]) for (const softness of [0, 250, 20000]) {
    let last = 0;
    for (const y of [0, 100, 750, 800, 1000, 1100, 20000, 22000, 100000]) {
      const node = { y, vy: 0 };
      applyAreaForce([node], gap, softness, 1);
      const force = Math.abs(node.vy);
      const opacity = forceOpacity(y, gap, softness);
      assert.ok(Math.abs(opacity - 0.3 * force / (DEFAULT_SETTINGS.maxForce + 72)) < 1e-12);
      assert.equal(opacity, forceOpacity(-y, gap, softness));
      assert.ok(opacity >= last && opacity < 0.3);
      last = opacity;
    }
  }
});

test("gradient tracks graph coordinates through pan and zoom and preserves the clear band", () => {
  const full = forceGradient(-2000, 2000, 2000, 250);
  assert.ok(full.includes("rgba(139, 92, 246, 0.00000) 31.25%"));
  assert.ok(full.includes("rgba(139, 92, 246, 0.00000) 68.75%"));
  const panned = forceGradient(-1000, 3000, 2000, 250);
  assert.ok(panned.includes("rgba(139, 92, 246, 0.00000) 6.25%"));
  assert.ok(panned.includes("rgba(139, 92, 246, 0.00000) 43.75%"));
  const zoomed = forceGradient(-1000, 1000, 2000, 250);
  assert.ok(zoomed.includes("rgba(139, 92, 246, 0.00000) 12.5%"));
  assert.ok(zoomed.includes("rgba(139, 92, 246, 0.00000) 87.5%"));
  assert.equal(forceGradient(0, 0, 2000, 250), "none");
  assert.equal(forceGradient(NaN, 1000, 2000, 250), "none");
  assert.equal(forceGradient(-2000, 2000, 2000, 250, 0), "none");
  assert.equal(forceOpacity(5000, 2000, 250, 0), 0);
  assert.ok(forceOpacity(5000, 2000, 250, 20) < forceOpacity(5000, 2000, 250, 100));
});

test("visualizer spans the full softness distance and shows a sharp edge only at zero softness", () => {
  for (const maximum of [20, 100, 1000]) {
    const full = forceOpacity(20000, 40000, 10000, maximum);
    assert.equal(forceOpacity(10000, 40000, 10000, maximum), 0);
    assert.equal(forceOpacity(15000, 40000, 10000, maximum), full * 0.5);
    const gradient = forceGradient(0, 30000, 40000, 10000, maximum);
    assert.ok(gradient.includes(`rgba(139, 92, 246, ${(full * 0.5).toFixed(5)}) 50%`));
  }
  const sharp = forceGradient(-2000, 2000, 2000, 0);
  assert.ok(sharp.includes("0.03659) 25%, rgba(139, 92, 246, 0.00000) 25%"));
  assert.ok(sharp.includes("0.00000) 75%, rgba(139, 92, 246, 0.03659) 75%"));
  assert.ok(!forceGradient(-2000, 2000, 0, 0).includes("0.00000"), "Zero gap has no clear interval");
});

test("overlay uses its graph window, follows viewport changes and removes itself cleanly", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  const element = { style: {} as Record<string, string>, className: "", removed: false,
    setAttribute(name: string, value: string) { assert.equal(name, "aria-hidden"); assert.equal(value, "true"); },
    remove() { this.removed = true; } };
  const container = { isConnected: true,
    ownerDocument: { defaultView: {
      requestAnimationFrame(fn: FrameRequestCallback) { callbacks.set(++next, fn); return next; },
      cancelAnimationFrame(id: number) { callbacks.delete(id); },
    } },
    createDiv(options: { cls: string }) { element.className = options.cls; return element; },
  } as unknown as HTMLElement;
  const settings = { ...DEFAULT_SETTINGS, barrierDistance: 2000, edgeSoftness: 250, showForceVisualizer: true };
  const renderer = { containerEl: container, viewport: { top: -2000, bottom: 2000 } } as GraphRenderer;
  const visualizer = new ForceVisualizer(renderer, () => settings, container);
  assert.equal(element.style.pointerEvents, "none");
  assert.equal(element.style.backgroundImage, forceGradient(-2000, 2000, 2000, 250));
  const frame = () => { const [id, fn] = callbacks.entries().next().value!; callbacks.delete(id); fn(0); };
  renderer.viewport = { top: -1000, bottom: 3000 };
  frame();
  assert.equal(element.style.backgroundImage, forceGradient(-1000, 3000, 2000, 250));
  settings.edgeSoftness = 0;
  frame();
  assert.equal(element.style.backgroundImage, forceGradient(-1000, 3000, 2000, 0));
  settings.maxForce = 0;
  frame();
  assert.equal(element.style.backgroundImage, "none");
  settings.showForceVisualizer = false;
  frame();
  assert.equal(element.removed, true);
  assert.equal(callbacks.size, 0);
  assert.equal(visualizer.matches(container), false);
  visualizer.detach();
});

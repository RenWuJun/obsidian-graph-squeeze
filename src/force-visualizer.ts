import type { GraphRenderer } from "./graph-bridge";
import { DEFAULT_SETTINGS, type SqueezeSettings } from "./settings";
import { barrierForceAt } from "./area-force";

/** Visualize the spatial pressure field, independent of simulation temperature
 * and a particular node's velocity. The clear band is completely transparent.
 */
export function forceOpacity(y: number, gap: number, softness: number, maxForce = DEFAULT_SETTINGS.maxForce): number {
  const force = barrierForceAt(y, gap, softness, maxForce);
  // Opacity is proportional to progress through this force ramp. A lower
  // maximum also makes the whole tint fainter, without moving the transition.
  return force === 0 ? 0 : 0.3 * force / (maxForce + 72);
}

export function forceGradient(top: number, bottom: number, gap: number, softness: number, maxForce = DEFAULT_SETTINGS.maxForce): string {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top || !Number.isFinite(maxForce) || maxForce <= 0) return "none";
  const half = gap / 2;
  const width = Math.max(0, Math.min(softness, half));
  const span = bottom - top;
  if (width === 0) {
    // A zero-width transition needs duplicate stops: interpolating between
    // boundaries would draw a gradient where the physics has a sharp step.
    const cuts = [...new Set([top, ...[-half, half].filter(y => y > top && y < bottom), bottom])];
    const colors: string[] = [];
    for (let i = 1; i < cuts.length; i++) {
      const opacity = forceOpacity((cuts[i - 1] + cuts[i]) / 2, gap, softness, maxForce);
      for (const y of [cuts[i - 1], cuts[i]]) {
        colors.push(`rgba(139, 92, 246, ${opacity.toFixed(5)}) ${(y - top) / span * 100}%`);
      }
    }
    return `linear-gradient(to bottom, ${colors.join(", ")})`;
  }
  const stops = new Set<number>([0, 1]);
  // Exact endpoints plus evenly spaced samples across the full ramp. These
  // positions do not depend on maximum force, including at extreme zoom.
  const positions = [0, half - width, half];
  for (let i = 1; i < 40; i++) {
    positions.push(half - width + width * i / 40);
  }
  for (const y of positions) for (const sign of [-1, 1]) {
    const fraction = (sign * y - top) / span;
    if (fraction > 0 && fraction < 1) stops.add(fraction);
  }
  const colors = [...stops].sort((a, b) => a - b).map(fraction => {
    const opacity = forceOpacity(top + span * fraction, gap, softness, maxForce);
    return `rgba(139, 92, 246, ${opacity.toFixed(5)}) ${fraction * 100}%`;
  });
  return `linear-gradient(to bottom, ${colors.join(", ")})`;
}

/** A pointer-transparent overlay in the graph's own document (including popouts).
 * Native viewport coordinates already account for pan, zoom and pixel density.
 */
export class ForceVisualizer {
  private readonly element: HTMLDivElement;
  private readonly win: Window;
  private frame = 0;
  private previous = "";
  private stopped = false;

  constructor(private renderer: GraphRenderer, private settings: () => SqueezeSettings,
    private container: HTMLElement) {
    const doc = container.ownerDocument;
    if (!doc.defaultView) throw new Error("Graph has no window for visualization.");
    this.win = doc.defaultView;
    this.element = container.createDiv({ cls: "graph-squeeze-force-visualizer" });
    this.element.setAttribute("aria-hidden", "true");
    Object.assign(this.element.style, {
      position: "absolute", inset: "0", pointerEvents: "none", zIndex: "0",
      userSelect: "none", borderRadius: "inherit",
    });
    this.draw();
  }

  matches(container: HTMLElement): boolean {
    return !this.stopped && this.container === container && this.win === container.ownerDocument.defaultView;
  }

  private draw = (): void => {
    if (this.stopped) return;
    if (!this.container.isConnected || this.renderer.destroyed ||
        this.win !== this.container.ownerDocument.defaultView || !this.settings().showForceVisualizer) {
      this.detach();
      return;
    }
    const viewport = this.renderer.viewport;
    const { barrierDistance, edgeSoftness, maxForce } = this.settings();
    const signature = `${viewport?.top}/${viewport?.bottom}/${barrierDistance}/${edgeSoftness}/${maxForce}`;
    if (signature !== this.previous) {
      this.previous = signature;
      this.element.style.backgroundImage = viewport
        ? forceGradient(viewport.top, viewport.bottom, barrierDistance, edgeSoftness, maxForce) : "none";
    }
    this.frame = this.win.requestAnimationFrame(this.draw);
  };

  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.win.cancelAnimationFrame(this.frame);
    this.element.remove();
  }
}

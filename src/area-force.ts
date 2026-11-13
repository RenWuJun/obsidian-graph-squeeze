export interface ForceNode {
  y: number;
  vy: number;
  fy?: number | null;
}

/** Spatial force before native cooling. Also used by the visualizer.
 * Keep this helper self-contained: its JavaScript is embedded in the worker.
 */
export function barrierForceAt(y: number, gap: number, edgeSoftness: number, maxForce: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(maxForce) || maxForce <= 0) return 0;
  const half = gap / 2;
  const width = Math.max(0, Math.min(edgeSoftness, half));
  const depth = Math.abs(y) - half;
  // Zero softness explicitly disables the transition; keep the center neutral.
  if (width === 0) return depth > 0 ? maxForce : 0;
  const approach = depth + width;
  if (approach <= 0) return 0;
  // Normalize by the full approach-zone width. Maximum force changes amplitude
  // only: 0% at the entrance, 50% halfway, 100% at and beyond the boundary.
  // Smoothstep has zero slope at both ends, without an early saturation curve.
  const t = Math.min(1, approach / width);
  return maxForce * t * t * (3 - 2 * t);
}

/** Runs before native integration; only adds the soft barrier's vertical force.
 * Embed together with barrierForceAt; all other forces remain native.
 */
export function applyAreaForce(nodes: ForceNode[], gap: number, edgeSoftness = 0, alpha = 1, maxForce = 10): boolean {
  const temperature = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;
  if (temperature === 0) return false;
  let changed = false;
  for (const node of nodes) {
    if (node.fy != null || !Number.isFinite(node.y) || !Number.isFinite(node.vy)) continue;
    const force = barrierForceAt(node.y, gap, edgeSoftness, maxForce);
    if (force === 0) continue;
    node.vy -= (node.y < 0 ? -1 : 1) * force * temperature;
    changed = true;
  }
  return changed;
}

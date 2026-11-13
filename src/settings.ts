export interface SqueezeSettings {
  barrierDistance: number;
  edgeSoftness: number;
  maxForce: number;
  showForceVisualizer: boolean;
}

export const DISTANCE_LIMITS = { min: 0, max: 80_000 } as const;
export const EDGE_SOFTNESS_LIMITS = { min: 0, max: 40_000 } as const;
export const MAX_FORCE_LIMITS = { min: 0, max: 1_000 } as const;
export const DEFAULT_SETTINGS: SqueezeSettings = {
  barrierDistance: 80_000, edgeSoftness: 10_000, maxForce: 10, showForceVisualizer: false,
};

export function normalizeSettings(input: unknown): SqueezeSettings {
  const data = input && typeof input === "object"
    ? input as Record<string, unknown> : {};
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  let distance = DEFAULT_SETTINGS.barrierDistance;
  if (finite(data.barrierDistance)) {
    distance = data.barrierDistance;
  } else if (finite(data.topDistance) || finite(data.bottomDistance) || finite(data.padding)) {
    // Migrate the previous independent distances, including pre-1.1.1 clearance.
    const top = finite(data.topDistance) ? Math.min(100_000, Math.max(20, data.topDistance)) : 20_000;
    const bottom = finite(data.bottomDistance) ? Math.min(100_000, Math.max(20, data.bottomDistance)) : 20_000;
    const padding = finite(data.padding)
      ? Math.min(100, Math.max(0, data.padding), (top + bottom) / 2 - 1) : 0;
    distance = Math.max(20, top - padding) + Math.max(20, bottom - padding);
  }
  return {
    barrierDistance: Math.min(DISTANCE_LIMITS.max, Math.max(DISTANCE_LIMITS.min, distance)),
    edgeSoftness: finite(data.edgeSoftness)
      ? Math.min(EDGE_SOFTNESS_LIMITS.max, Math.max(EDGE_SOFTNESS_LIMITS.min, data.edgeSoftness))
      : DEFAULT_SETTINGS.edgeSoftness,
    showForceVisualizer: data.showForceVisualizer === true,
    maxForce: finite(data.maxForce)
      ? Math.min(MAX_FORCE_LIMITS.max, Math.max(MAX_FORCE_LIMITS.min, data.maxForce))
      : DEFAULT_SETTINGS.maxForce,
  };
}

export function getBounds(settings: SqueezeSettings): { top: number; bottom: number } {
  const half = settings.barrierDistance / 2;
  return { top: -half, bottom: half };
}

export function adjustDistance(distance: number, factor: number): number {
  const scaled = Math.round(distance * factor);
  // Multiplication alone cannot reopen a zero gap or tighten a one-unit gap.
  const changed = factor > 1 ? Math.max(distance + 1, scaled) : Math.min(distance - 1, scaled);
  return Math.min(DISTANCE_LIMITS.max, Math.max(DISTANCE_LIMITS.min, changed));
}

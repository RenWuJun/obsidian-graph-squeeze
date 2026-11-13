import { applyAreaForce, barrierForceAt } from "./area-force";
import { DEFAULT_SETTINGS, DISTANCE_LIMITS, EDGE_SOFTNESS_LIMITS, MAX_FORCE_LIMITS } from "./settings";

/**
 * Add velocity forces to the installed native worker's step. Identify the
 * private names from structural signatures, require a unique match, and refuse
 * unfamiliar worker layouts. Never modify files in Obsidian's installation or
 * distribute its source. Both WASM and JS continue using the native integrator.
 */
export function instrumentWorker(source: string): string {
  const tickPattern = /function\s+([\w$]+)\(\)\{if\(([\w$]+)=null,([\w$]+)>([\w$.]+)\)\{if\(([\w$]+)\(\),(?:0===([\w$]+)\.length|([\w$]+)\.length===0)\)return;([^{};]+),([\w$]+)\(\),([\w$]+)\(\)\}\}/g;
  const ticks = [...source.matchAll(tickPattern)];
  const dirty = [...source.matchAll(/\.index=[\w$]+\}([\w$]+)=!0\}/g)];
  const forceCache = [...source.matchAll(/\.distance\([\w$]+\),[\w$]+\.strength\([\w$]+\),([\w$]+)=!1\)/g)];
  const handlers = [...source.matchAll(/self\.onmessage=function\(([\w$]+)\)\{/g)];
  if (ticks.length !== 1 || dirty.length !== 1 || forceCache.length !== 1 || handlers.length !== 1 ||
      !source.includes("self.onmessage=function") || !source.includes(".forceNode") ||
      !source.includes(".forces") || !source.includes("WebAssembly")) {
    throw new Error("This Obsidian graph worker has an unsupported physics layout.");
  }
  const tick = ticks[0];
  const nodes = tick[6] || tick[7];
  const dirtyFlag = dirty[0][1];
  const synchronize = new RegExp(`if\\(${dirtyFlag.replace(/\$/g, "\\$")}\\|\\|[\\w$]+\\)`);
  if (!synchronize.test(source)) throw new Error("Could not identify native physics synchronization.");
  const oldStep = `,${tick[9]}(),${tick[10]}()`;
  if (!tick[0].endsWith(`${oldStep}}}`)) throw new Error("Unsupported native step order.");
  const replacement = tick[0].replace(oldStep,
    `,(self.__graphSqueezeApply(${nodes},${tick[3]})&&(${dirtyFlag}=!0)),${tick[9]}(),${tick[10]}()`);
  let patched = source.slice(0, tick.index) + replacement + source.slice(tick.index + tick[0].length);
  // The JS fallback caches force strengths. In the inspected native workers the
  // message handler updates their values without invalidating this cache.
  // Refresh it on real force messages, including initial saved slider settings.
  const handler = handlers[0];
  patched = patched.replace(handler[0],
    `${handler[0]}if(${handler[1]}.data&&${handler[1]}.data.forces!==void 0)${forceCache[0][1]}=!0;`);
  return `
self.__graphSqueezeGap = ${DEFAULT_SETTINGS.barrierDistance};
self.__graphSqueezeSoftness = ${DEFAULT_SETTINGS.edgeSoftness};
self.__graphSqueezeMaxForce = ${DEFAULT_SETTINGS.maxForce};
const barrierForceAt = ${barrierForceAt.toString()};
self.__graphSqueezeApply = function(nodes, alpha) {
  return (${applyAreaForce.toString()})(nodes, self.__graphSqueezeGap, self.__graphSqueezeSoftness, alpha, self.__graphSqueezeMaxForce);
};
${patched}
const graphSqueezeNativeMessage = self.onmessage;
self.onmessage = function(event) {
  const config = event.data && event.data.__graphSqueeze;
  if (config) {
    if (Number.isFinite(config.gap)) self.__graphSqueezeGap = Math.max(0, Math.min(${DISTANCE_LIMITS.max}, config.gap));
    if (Number.isFinite(config.edgeSoftness)) self.__graphSqueezeSoftness = Math.max(0, Math.min(${EDGE_SOFTNESS_LIMITS.max}, config.edgeSoftness));
    if (Number.isFinite(config.maxForce)) self.__graphSqueezeMaxForce = Math.max(0, Math.min(${MAX_FORCE_LIMITS.max}, config.maxForce));
    return;
  }
  graphSqueezeNativeMessage.call(self, event);
};
postMessage({ __graphSqueezeReady: true });
`;
}

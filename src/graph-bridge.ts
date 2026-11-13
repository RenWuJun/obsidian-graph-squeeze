import { type SqueezeSettings } from "./settings";

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}
export interface GraphRenderer {
  containerEl?: HTMLElement;
  viewport?: { top: number; bottom: number } | null;
  destroyed?: boolean;
  worker: Worker;
  nodes: GraphNode[];
  links: { source: { id: string }; target: { id: string } }[];
  dragNode?: GraphNode | null;
  workerResults?: unknown;
  changed(): void;
}
export interface GraphForces {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}
interface Positions { id: string[]; buffer: ArrayBufferLike }
type NodePositions = Record<string, [number, number] | null>;
export interface BridgeOptions {
  createWorker: () => Worker;
  forces: GraphForces;
}

function isPositions(value: unknown): value is Positions {
  if (!value || typeof value !== "object") return false;
  const data = value as Positions;
  return Array.isArray(data.id) && data.id.every(id => typeof id === "string") &&
    !!data.buffer && data.buffer.byteLength >= data.id.length * 8 &&
    ["[object ArrayBuffer]", "[object SharedArrayBuffer]"].includes(
      Object.prototype.toString.call(data.buffer));
}

export function getRenderer(view: unknown): GraphRenderer | null {
  const renderer = (view as { renderer?: GraphRenderer } | null)?.renderer;
  return renderer && Array.isArray(renderer.nodes) && Array.isArray(renderer.links) &&
    renderer.worker && typeof renderer.worker.postMessage === "function" &&
    typeof renderer.worker.terminate === "function" &&
    typeof renderer.worker.onmessage === "function" &&
    typeof renderer.changed === "function" ? renderer : null;
}

/** Native force controls store nonlinear slider values, not worker strengths. */
export function getGraphForces(view: unknown): GraphForces {
  const graph = view as { dataEngine?: { getOptions(): Record<string, unknown> }; engine?: { getOptions(): Record<string, unknown> } };
  const options = (graph.dataEngine ?? graph.engine)?.getOptions() ?? {};
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const strength = (value: number) => (Math.pow(0.01, 1 - value) - 0.01) / 0.99;
  return {
    centerStrength: finite(options.centerStrength) ? strength(options.centerStrength) : 0.1,
    repelStrength: finite(options.repelStrength) ? Math.pow(options.repelStrength, 3) : 1000,
    linkStrength: finite(options.linkStrength) ? strength(options.linkStrength) : 1,
    linkDistance: finite(options.linkDistance) ? options.linkDistance : 250,
  };
}

/** Route the renderer to a native worker extended with a directional force.
 * Keep the original worker and its topology/force settings ready for clean restore.
 */
export class GraphBridge {
  private active = true;
  private readonly worker: Worker;
  private readonly simulation: Worker;
  private readonly originalPost: (message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void;
  private readonly originalMessage: Worker["onmessage"];
  private readonly originalTerminate: () => void;
  private readonly ownPost?: PropertyDescriptor;
  private readonly ownTerminate?: PropertyDescriptor;
  private readonly timerWindow: Window;
  private readyTimer: number | undefined;
  private positions = new Map<string, [number, number] | null>();
  private alphaTarget: number;

  constructor(
    readonly renderer: GraphRenderer,
    private readonly settings: () => SqueezeSettings,
    private readonly onError: (error: unknown) => void,
    options: BridgeOptions,
  ) {
    this.worker = renderer.worker;
    const originalPost = this.worker.postMessage.bind(this.worker);
    this.originalPost = (message, options) => {
      if (Array.isArray(options)) originalPost(message, options);
      else originalPost(message, options);
    };
    this.originalMessage = this.worker.onmessage;
    this.originalTerminate = this.worker.terminate.bind(this.worker);
    this.timerWindow = renderer.containerEl?.ownerDocument.defaultView ?? window;
    this.ownPost = Object.getOwnPropertyDescriptor(this.worker, "postMessage");
    this.ownTerminate = Object.getOwnPropertyDescriptor(this.worker, "terminate");
    this.alphaTarget = renderer.dragNode ? 0.3 : 0;
    for (const node of renderer.nodes) this.positions.set(node.id,
      Number.isFinite(node.x) && Number.isFinite(node.y) ? [node.x, node.y] : null);
    this.simulation = options.createWorker();
    try {
      this.simulation.onmessage = this.receive;
      this.simulation.onerror = event => {
        event.preventDefault();
        this.fail(new Error(event.message || "Directional-force worker failed."));
      };
      this.simulation.onmessageerror = () => this.fail(new Error("Could not read directional-force worker output."));
      // Drag handlers capture this object, so preserve its identity and proxy it.
      this.worker.postMessage = this.post;
      this.worker.onmessage = this.ignoreOriginal;
      this.worker.terminate = this.terminate;
      this.readyTimer = this.timerWindow.setTimeout(() => this.fail(new Error("Directional-force worker did not start.")), 5000);
      this.sendOriginal({ alphaTarget: 0 });
      this.simulation.postMessage({ __graphSqueeze: {
        gap: settings().barrierDistance, edgeSoftness: settings().edgeSoftness, maxForce: settings().maxForce,
      } });
      const nodes: NodePositions = Object.fromEntries(this.positions);
      this.simulation.postMessage({ nodes,
        links: renderer.links.map(link => [link.source.id, link.target.id]),
        forces: options.forces, alphaTarget: this.alphaTarget, alpha: 0.3, run: true });
      for (const node of renderer.nodes) if (node.fx != null || node.fy != null) {
        this.simulation.postMessage({ forceNode: { id: node.id, x: node.fx ?? null, y: node.fy ?? null } });
      }
    } catch (error) {
      this.detach(false);
      throw error;
    }
  }

  private sendOriginal(message: unknown): void {
    this.originalPost(message);
  }

  private post = (message: unknown, options?: Transferable[] | StructuredSerializeOptions): void => {
    if (!this.active) {
      this.originalPost(message, options);
      return;
    }
    try {
      if (message && typeof message === "object") {
        const data = message as Record<string, unknown>;
        if (data.nodes && typeof data.nodes === "object") {
          const next = new Map<string, [number, number] | null>();
          for (const [id, point] of Object.entries(data.nodes as NodePositions)) {
            next.set(id, point ?? this.positions.get(id) ?? null);
          }
          this.positions = next;
        }
        if (typeof data.alphaTarget === "number") this.alphaTarget = data.alphaTarget;
        // Copy through the original worker first, without a transfer list. It
        // retains current topology, forces and drag pins but is allowed to cool.
        const { run: _run, alpha: _alpha, alphaTarget: _target, ...mirror } = data;
        this.sendOriginal(mirror);
      }
      if (Array.isArray(options)) this.simulation.postMessage(message, options);
      else this.simulation.postMessage(message, options);
    } catch (error) {
      this.fail(error);
    }
  };

  private ignoreOriginal = (event: MessageEvent): void => {
    if (!this.active) this.originalMessage?.call(this.worker, event);
  };

  private receive = (event: MessageEvent<unknown>): void => {
    if (!this.active) return;
    const message = event.data;
    if (message && typeof message === "object" && "__graphSqueezeReady" in message && message.__graphSqueezeReady === true) {
      this.timerWindow.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      return;
    }
    if (message && typeof message === "object" && "ignore" in message && message.ignore === true) return;
    if (!isPositions(message)) {
      this.fail(new Error("Unsupported graph position protocol."));
      return;
    }
    const data = message;
    if (data.id.length !== this.positions.size || !data.id.every(id => this.positions.has(id))) return;
    try {
      const points = new Float32Array(data.buffer, 0, data.id.length * 2);
      for (let i = 0; i < data.id.length; i++) {
        const x = points[i * 2];
        const y = points[i * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Non-finite graph position.");
        this.positions.set(data.id[i], [x, y]);
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    // Pass native output directly through. No clipping, ghost nodes or post-hoc
    // position corrections: the soft barrier acts on vertical velocity inside the simulation.
    this.originalMessage?.call(this.worker, event);
  };

  reheat(): void {
    if (!this.active) return;
    try {
      this.simulation.postMessage({ __graphSqueeze: {
        gap: this.settings().barrierDistance, edgeSoftness: this.settings().edgeSoftness, maxForce: this.settings().maxForce,
      } });
      this.simulation.postMessage({ alpha: 0.3, run: true });
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    if (!this.active) return;
    this.detach();
    this.onError(error);
  }

  private terminate = (): void => {
    this.detach(false);
    this.originalTerminate();
  };

  detach(reheat = true): void {
    if (!this.active) return;
    this.active = false;
    this.timerWindow.clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.simulation.onmessage = null;
    this.simulation.onerror = null;
    this.simulation.onmessageerror = null;
    this.simulation.terminate();
    if (this.worker.postMessage === this.post) {
      if (this.ownPost) Object.defineProperty(this.worker, "postMessage", this.ownPost);
      else delete (this.worker as Partial<Worker>).postMessage;
    }
    if (this.worker.terminate === this.terminate) {
      if (this.ownTerminate) Object.defineProperty(this.worker, "terminate", this.ownTerminate);
      else delete (this.worker as Partial<Worker>).terminate;
    }
    if (this.worker.onmessage === this.ignoreOriginal) this.worker.onmessage = this.originalMessage;
    this.renderer.workerResults = null;
    try {
      this.sendOriginal({ nodes: Object.fromEntries(this.positions), alphaTarget: this.alphaTarget,
        ...(reheat ? { alpha: 0.3, run: true } : {}) });
    } catch { /* Pane already closed. */ }
  }
}

import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { GraphBridge, getGraphForces, getRenderer, type GraphRenderer } from "./graph-bridge";
import { adjustDistance, DEFAULT_SETTINGS, DISTANCE_LIMITS, EDGE_SOFTNESS_LIMITS, MAX_FORCE_LIMITS, normalizeSettings, type SqueezeSettings } from "./settings";
import { instrumentWorker } from "./worker-source";
import { ForceVisualizer } from "./force-visualizer";

export default class GraphSqueezePlugin extends Plugin {
  settings: SqueezeSettings = { ...DEFAULT_SETTINGS };
  private bridges = new Map<GraphRenderer, GraphBridge>();
  private visualizers = new Map<GraphRenderer, ForceVisualizer>();
  private failed = new WeakSet<GraphRenderer>();
  private warned = false;
  private stopped = false;
  private saves: Promise<void> = Promise.resolve();
  private workerUrl?: string;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new SqueezeSettingTab(this.app, this));
    for (const [id, name, factor] of [
      ["squeeze", "Move barriers closer together", 0.8],
      ["expand", "Move barriers farther apart", 1.25],
    ] as const) {
      this.addCommand({ id, name, callback: async () => {
        await this.updateSettings({
          barrierDistance: adjustDistance(this.settings.barrierDistance, factor),
        });
        new Notice(`Barrier distance: ${this.settings.barrierDistance} graph units.`);
      } });
    }
    this.addCommand({ id: "reset-barriers", name: "Reset barrier distance", callback: async () => {
      await this.updateSettings({ barrierDistance: DEFAULT_SETTINGS.barrierDistance });
      new Notice("Barrier distance reset.");
    } });
    try {
      // Read only the native worker bundled with the running Obsidian app.
      const response = await fetch(new URL("/sim.js", window.location.href));
      if (!response.ok) throw new Error(`Cannot read the native graph worker (${response.status}).`);
      const source = instrumentWorker(await response.text());
      if (this.stopped) return;
      this.workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    } catch (error) {
      this.warn(error);
      return;
    }
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.syncGraphs();
      this.registerEvent(this.app.workspace.on("layout-change", () => this.syncGraphs()));
      // Catch deferred graph loading, renderer recreation, and pop-out windows.
      this.registerInterval(window.setInterval(() => this.syncGraphs(), 1000));
    });
  }

  async updateSettings(update: Partial<SqueezeSettings>): Promise<void> {
    const previous = this.settings;
    this.settings = normalizeSettings({ ...this.settings, ...update });
    this.syncGraphs();
    if (previous.barrierDistance !== this.settings.barrierDistance || previous.edgeSoftness !== this.settings.edgeSoftness ||
        previous.maxForce !== this.settings.maxForce) {
      for (const bridge of this.bridges.values()) bridge.reheat();
    }
    const snapshot = { ...this.settings };
    this.saves = this.saves.catch(() => {}).then(() => this.saveData(snapshot));
    try { await this.saves; }
    catch (error) {
      console.error("Graph Squeeze: settings could not be saved", error);
      new Notice("Graph Squeeze could not save settings. Check the developer console.");
    }
  }

  private syncGraphs(): void {
    if (this.stopped || !this.workerUrl) return;
    const wanted = new Set<GraphRenderer>();
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const renderer = getRenderer(leaf.view);
        if (!renderer) {
          // A deferred leaf has no renderer yet. Only warn when one exists.
          if ((leaf.view as unknown as { renderer?: unknown }).renderer) this.warn();
          continue;
        }
        wanted.add(renderer);
        if (this.bridges.has(renderer) || this.failed.has(renderer)) continue;
        try {
          const bridge = new GraphBridge(renderer, () => this.settings, error => {
            this.failed.add(renderer);
            this.bridges.delete(renderer);
            this.visualizers.get(renderer)?.detach();
            this.visualizers.delete(renderer);
            this.warn(error);
          }, { createWorker: () => new Worker(this.workerUrl!, { name: "Graph Squeeze physics" }),
            forces: getGraphForces(leaf.view) });
          this.bridges.set(renderer, bridge);
          bridge.reheat();
        } catch (error) {
          this.bridges.get(renderer)?.detach(false);
          this.bridges.delete(renderer);
          this.failed.add(renderer);
          this.warn(error);
        }
      }
    }
    for (const [renderer, bridge] of this.bridges) {
      if (!wanted.has(renderer)) {
        bridge.detach();
        this.bridges.delete(renderer);
      }
    }
    this.syncVisualizers();
  }

  private syncVisualizers(): void {
    for (const [renderer, visualizer] of this.visualizers) {
      if (!this.settings.showForceVisualizer || !this.bridges.has(renderer) ||
          !renderer.containerEl || !visualizer.matches(renderer.containerEl)) {
        visualizer.detach();
        this.visualizers.delete(renderer);
      }
    }
    if (!this.settings.showForceVisualizer) return;
    for (const renderer of this.bridges.keys()) {
      if (this.visualizers.has(renderer) || renderer.destroyed || !renderer.containerEl?.isConnected) continue;
      this.visualizers.set(renderer, new ForceVisualizer(renderer, () => this.settings, renderer.containerEl));
    }
  }

  private warn(error?: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("Graph Squeeze: unsupported graph worker", error);
    new Notice("Graph Squeeze could not attach to this graph. The normal graph is still available. Check the developer console.", 10000);
  }

  onunload(): void {
    this.stopped = true;
    for (const visualizer of this.visualizers.values()) visualizer.detach();
    this.visualizers.clear();
    for (const bridge of this.bridges.values()) bridge.detach();
    this.bridges.clear();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = undefined;
  }
}

class SqueezeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GraphSqueezePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Two invisible force areas squeeze your graph: the area above pushes downward, and the area below pushes upward. Only the distance below sets their boundaries." });
    this.numberSetting("barrierDistance", "Barrier distance",
      "Total gap between the top and bottom boundaries, in graph units. Range: 0–80,000; default: 80,000.", DISTANCE_LIMITS);
    this.numberSetting("edgeSoftness", "Edge softness",
      "Full distance from zero to maximum force, in graph units. The push is half strength halfway through and full strength at the boundary. Range: 0–40,000; default: 10,000. Limited to half the gap so the approach zones do not overlap.", EDGE_SOFTNESS_LIMITS);
    containerEl.createEl("p", { cls: "setting-item-description", text: "Softness does not move the boundaries. The push ramps smoothly across the entire softness distance and stays at maximum beyond the boundary. Zero softness (or zero gap) gives a sharp transition. Applies to global and local graphs." });
    this.numberSetting("maxForce", "Maximum barrier force",
      "Limit the barrier push. Lower values feel gentler; higher values squeeze harder. Range: 0–1,000; default: 10. Zero disables the barrier force. Changes strength without changing the transition distance. The push weakens as the graph settles.", MAX_FORCE_LIMITS);
    new Setting(containerEl).setName("Barrier force visualizer")
      .setDesc("Show a violet tint over the barrier force areas. Weaker force is more transparent; stronger force has more color. Follows pan and zoom. Off by default.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.showForceVisualizer)
        .onChange(value => this.plugin.updateSettings({ showForceVisualizer: value })));
  }

  private numberSetting(key: "barrierDistance" | "edgeSoftness" | "maxForce", name: string, description: string, limits: { min: number; max: number }): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(description);
    let field: HTMLInputElement;
    setting.addSlider(slider => {
      slider.setLimits(limits.min, limits.max, 1).setDynamicTooltip().setValue(this.plugin.settings[key])
        .onChange(async value => {
          if (field) field.value = String(value);
          await this.plugin.updateSettings({ [key]: value });
        });
      setting.addText(text => {
        field = text.inputEl;
        field.type = "number";
        field.min = String(limits.min);
        field.max = String(limits.max);
        field.step = "1";
        field.setAttribute("aria-label", name);
        text.setValue(String(this.plugin.settings[key]));
        // Commit on change (blur/Enter), allowing intermediate empty values.
        field.addEventListener("change", () => {
          const value = Number(field.value);
          if (!field.value.trim() || !Number.isFinite(value)) {
            field.value = String(this.plugin.settings[key]);
            return;
          }
          void this.plugin.updateSettings({ [key]: value });
          field.value = String(this.plugin.settings[key]);
          slider.setValue(this.plugin.settings[key]);
        });
      });
    });
  }
}

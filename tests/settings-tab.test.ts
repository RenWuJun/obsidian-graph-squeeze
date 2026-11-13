import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = build({ entryPoints: ["src/main.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"] });

class Control {
  value: unknown;
  limits?: number[];
  change: (value: any) => unknown = () => {};
  inputEl = { value: "", type: "", min: "", max: "", step: "",
    setAttribute() {}, addEventListener: (_name: string, callback: () => void) => { this.commit = callback; } };
  commit = () => {};
  setLimits(...limits: number[]) { this.limits = limits; return this; }
  setValue(value: unknown) { this.value = value; this.inputEl.value = String(value); return this; }
  onChange(callback: (value: any) => unknown) { this.change = callback; return this; }
}
class SettingStub {
  nameEl = { textContent: "" };
  desc = "";
  slider?: Control;
  text?: Control;
  toggle?: Control;
  constructor(container: { rows: SettingStub[] }) { container.rows.push(this); }
  setName(name: string) { this.nameEl.textContent = name; return this; }
  setDesc(desc: string) { this.desc = desc; return this; }
  addSlider(callback: (control: Control) => void) { callback(this.slider = new Control()); return this; }
  addText(callback: (control: Control) => void) { callback(this.text = new Control()); return this; }
  addToggle(callback: (control: Control) => void) { callback(this.toggle = new Control()); return this; }
}

for (const mode of ["legacy display", "searchable definitions"]) {
  test(`${mode} renders working settings and persists normalized changes`, async () => {
    const saved: unknown[] = [];
    const requests: string[] = [];
    const obsidian = {
      Plugin: class {
        app = {};
        tab: any;
        loadData() { return Promise.resolve({}); }
        saveData(value: unknown) { saved.push(structuredClone(value)); return Promise.resolve(); }
        addSettingTab(tab: unknown) { this.tab = tab; }
        addCommand() {}
      },
      // No newer settings methods on this base: the legacy path must still work.
      PluginSettingTab: class {
        containerEl = { rows: [] as SettingStub[], empty() { this.rows = []; } };
      },
      Setting: SettingStub,
      Notice: class {},
    };
    const context = vm.createContext({ module: { exports: {} },
      require: (name: string) => { assert.equal(name, "obsidian"); return obsidian; },
      console: { warn() {} }, URL, window: { location: { href: "app://obsidian.md/index.html" } },
      fetch: (url: URL) => {
        requests.push(url.href);
        // A missing native worker must not prevent settings from being usable.
        return Promise.resolve({ ok: false, status: 404 });
      },
    });
    vm.runInContext((await bundle).outputFiles[0].text, context);
    const plugin = new context.module.exports.default();
    await plugin.onload();
    assert.deepEqual(requests, ["app://obsidian.md/sim.js"]);
    const tab = plugin.tab;
    if (mode === "legacy display") tab.display();
    else {
      const definitions = tab.getSettingDefinitions();
      assert.equal(definitions.length, 4);
      for (const definition of definitions) {
        assert.ok(definition.name.length && definition.desc.length);
        definition.render(new SettingStub(tab.containerEl).setName(definition.name).setDesc(definition.desc));
      }
    }
    const rows = tab.containerEl.rows as SettingStub[];
    assert.deepEqual(rows.map(row => row.nameEl.textContent), [
      "Barrier distance", "Edge softness", "Maximum barrier force", "Barrier force visualizer",
    ]);
    assert.deepEqual(rows.slice(0, 3).map(row => row.slider!.limits), [[0, 80000, 1], [0, 40000, 1], [0, 1000, 1]]);
    assert.deepEqual(rows.slice(0, 3).map(row => row.text!.inputEl.value), ["80000", "10000", "10"]);
    await rows[0].slider!.change(12000);
    assert.equal(plugin.settings.barrierDistance, 12000);
    assert.equal(rows[0].text!.inputEl.value, "12000");
    const field = rows[1].text!;
    field.inputEl.value = "99999";
    field.commit();
    assert.equal(plugin.settings.edgeSoftness, 40000);
    assert.equal(field.inputEl.value, "40000");
    assert.equal(rows[1].slider!.value, 40000);
    field.inputEl.value = "";
    field.commit();
    assert.equal(field.inputEl.value, "40000");
    await rows[2].slider!.change(0);
    assert.equal(plugin.settings.maxForce, 0);
    await rows[3].toggle!.change(true);
    assert.equal(plugin.settings.showForceVisualizer, true);
    assert.deepEqual(saved.at(-1), structuredClone(plugin.settings));
  });
}

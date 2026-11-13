import assert from "node:assert/strict";

/** A popout window with its own timer namespace, separate from Node's globals. */
export function timerWindow() {
  let next = 0;
  const pending = new Map<number, () => void>();
  const win = {
    setTimeout(callback: () => void, delay: number) {
      assert.equal(delay, 5000);
      pending.set(++next, callback);
      return next;
    },
    clearTimeout(id?: number) { if (id !== undefined) pending.delete(id); },
  } as unknown as Window;
  const containerEl = { ownerDocument: { defaultView: win } } as HTMLElement;
  return { win, containerEl, pending };
}

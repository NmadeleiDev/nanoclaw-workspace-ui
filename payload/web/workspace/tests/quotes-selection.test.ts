import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the hook's browser listeners without requiring a new DOM dependency.
const hooks = vi.hoisted(() => ({ cleanups: [] as (() => void)[], setSelection: vi.fn(), initialSelection: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [hooks.initialSelection, hooks.setSelection],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
import { useMessageQuotes } from '../src/quotes';

class ElementStub extends EventTarget {
  parentElement: ElementStub | null = null;
  isConnected = true;
  constructor(readonly attributes: Record<string, string> = {}) { super(); }
  closest(selector: string): ElementStub | null {
    if (selector === '[data-quote-source]' && 'data-quote-source' in this.attributes) return this;
    if (selector === '[data-quote-action]' && 'data-quote-action' in this.attributes) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
}
let doc: EventTarget & { activeElement: ElementStub | null; documentElement: ElementStub };
let source: ElementStub;
let nativeSelection: {
  anchorNode: ElementStub | null;
  isCollapsed: boolean;
  rangeCount: number;
  toString: () => string;
  getRangeAt: () => unknown;
  removeAllRanges: ReturnType<typeof vi.fn>;
};
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}
function event(type: string, properties: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true });
  Object.entries(properties).forEach(([key, value]) => Object.defineProperty(e, key, { value }));
  doc.dispatchEvent(e);
  return e;
}
function select() {
  nativeSelection.anchorNode = source;
  nativeSelection.isCollapsed = false;
  nativeSelection.rangeCount = 1;
  event('selectionchange');
  flush();
  expect(hooks.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Selected passage' }));
}
beforeEach(() => {
  hooks.setSelection.mockReset();
  hooks.initialSelection = null;
  frames = new Map();
  nextFrame = 0;
  source = new ElementStub({ 'data-quote-source': 'message-one' });
  doc = Object.assign(new EventTarget(), { activeElement: null, documentElement: new ElementStub() });
  nativeSelection = {
    anchorNode: null, isCollapsed: true, rangeCount: 0,
    toString: () => 'Selected passage',
    getRangeAt: () => ({ startContainer: source, endContainer: source,
      getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120, width: 100, height: 20 }) }),
    removeAllRanges: vi.fn(() => {
      nativeSelection.anchorNode = null;
      nativeSelection.isCollapsed = true;
      nativeSelection.rangeCount = 0;
      event('selectionchange');
    }),
  };
  vi.stubGlobal('Element', ElementStub);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    getSelection: () => nativeSelection, innerWidth: 390, innerHeight: 844,
  }));
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '16px' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});
it('clears a retained native selection on an outside tap without quoting or resurrecting it', () => {
  const onQuote = vi.fn(() => true);
  const { quote } = useMessageQuotes('one', true, onQuote);
  select();
  event('pointerdown', { target: new ElementStub(), pointerType: 'touch' });
  event('pointerup');
  flush();
  expect(nativeSelection.removeAllRanges).toHaveBeenCalledOnce();
  expect(hooks.setSelection).toHaveBeenLastCalledWith(null);
  quote();
  expect(onQuote).not.toHaveBeenCalled();
});
it('preserves native selection while adjusting touch handles or scrolling within the message', () => {
  useMessageQuotes('one', true, vi.fn());
  select();
  event('pointerdown', { target: source, pointerType: 'touch' });
  event('selectionchange');
  event('pointercancel');
  flush();
  expect(nativeSelection.removeAllRanges).not.toHaveBeenCalled();
  expect(hooks.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Selected passage' }));
});
it('Escape clears both native and saved selection, including a pending frame', () => {
  const onQuote = vi.fn(() => true);
  const { quote } = useMessageQuotes('one', true, onQuote);
  select();
  event('selectionchange');
  event('keydown', { key: 'Escape' });
  event('keyup', { key: 'Escape' });
  flush();
  expect(nativeSelection.removeAllRanges).toHaveBeenCalledOnce();
  expect(hooks.setSelection).toHaveBeenLastCalledWith(null);
  quote();
  expect(onQuote).not.toHaveBeenCalled();
});
it('preserves selection for the Quote action and clears it only after the quote is accepted', () => {
  const onQuote = vi.fn(() => true);
  const { quote } = useMessageQuotes('one', true, onQuote);
  select();
  event('pointerdown', { target: new ElementStub({ 'data-quote-action': '' }) });
  event('pointerup');
  flush();
  expect(nativeSelection.removeAllRanges).not.toHaveBeenCalled();
  quote();
  expect(onQuote).toHaveBeenCalledWith('Selected passage', undefined);
  expect(nativeSelection.removeAllRanges).toHaveBeenCalledOnce();
});
it('does not discard the passage when adding a quote fails', () => {
  const { quote } = useMessageQuotes('one', true, () => false);
  select();
  quote();
  expect(nativeSelection.removeAllRanges).not.toHaveBeenCalled();
});
it('unregisters listeners and cancels scheduled work on cleanup', () => {
  useMessageQuotes('one', true, vi.fn());
  select();
  event('selectionchange');
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  hooks.setSelection.mockClear();
  event('pointerdown', { target: new ElementStub() });
  event('keydown', { key: 'Escape' });
  flush();
  expect(nativeSelection.removeAllRanges).not.toHaveBeenCalled();
  expect(hooks.setSelection).not.toHaveBeenCalled();
});

it('provides a touch-sized clear action that discards selection without adding a quote', () => {
  const onQuote = vi.fn(() => true);
  useMessageQuotes('one', true, onQuote);
  select();
  hooks.initialSelection = hooks.setSelection.mock.lastCall![0];
  const { toolbar } = useMessageQuotes('one', true, onQuote);
  const clear = toolbar!.props.children[1];
  expect(clear.props['aria-label']).toBe('Clear text selection');
  clear.props.onClick();
  flush();
  expect(nativeSelection.removeAllRanges).toHaveBeenCalledOnce();
  expect(hooks.setSelection).toHaveBeenLastCalledWith(null);
  expect(onQuote).not.toHaveBeenCalled();
});
it('leaves selections outside quote sources alone', () => {
  useMessageQuotes('one', true, vi.fn());
  nativeSelection.anchorNode = new ElementStub();
  nativeSelection.isCollapsed = false;
  event('pointerdown', { target: new ElementStub() });
  event('keydown', { key: 'Escape' });
  expect(nativeSelection.removeAllRanges).not.toHaveBeenCalled();
});

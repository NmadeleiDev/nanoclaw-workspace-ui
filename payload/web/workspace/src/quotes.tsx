import React, { useCallback, useEffect, useRef, useState } from 'react';

export function appendQuote(draft: string, selectedText: string): string {
  const text = selectedText.replace(/\r\n?/g, '\n').trim();
  if (!text) return draft;
  const gap = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
  return draft + gap + text.split('\n').map(line => line ? `> ${line}` : '>').join('\n') + '\n\n';
}
export const QuoteIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
  <path d="M4 12h5v7H3v-7c0-4 2-6 6-7M16 12h5v7h-6v-7c0-4 2-6 6-7" />
</svg>;
type QuoteSelection = { session: string; messageId: string; text: string; left: number; top: number };
function sourceOf(node: Node | null): Element | null {
  return (node instanceof Element ? node : node?.parentElement)?.closest('[data-quote-source]') ?? null;
}
/** Native text selection remains intact; only a single assistant body is eligible. */
function readSelection(session: string): QuoteSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const source = sourceOf(range.startContainer);
  if (!source || source !== sourceOf(range.endContainer) || !source.isConnected) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const actionWidth = Math.max(120, parseFloat(getComputedStyle(document.documentElement).fontSize) * 5.5);
  return {
    session, messageId: source.getAttribute('data-quote-source')!, text,
    left: Math.max(12, Math.min(rect.left, window.innerWidth - actionWidth - 12)),
    top: Math.max(8, Math.min(rect.top >= 56 ? rect.top - 52 : rect.bottom + 8, window.innerHeight - 56)),
  };
}
export function useMessageQuotes(session: string, enabled: boolean, onQuote: (text: string) => boolean) {
  const [selection, setSelection] = useState<QuoteSelection | null>(null);
  const saved = useRef<QuoteSelection | null>(null);
  const onQuoteRef = useRef(onQuote); onQuoteRef.current = onQuote;
  const quote = useCallback((message?: {id: string; text: string}) => {
    if (!enabled) return;
    const current = readSelection(session) ?? saved.current;
    const text = current?.session === session && (!message || current.messageId === message.id) ? current.text : message?.text;
    if (text && onQuoteRef.current(text)) {
      saved.current = null; setSelection(null); window.getSelection()?.removeAllRanges();
    }
  }, [enabled, session]);
  useEffect(() => {
    saved.current = null; setSelection(null);
    if (!enabled) return;
    let frame = 0, dragging = false;
    const update = () => {
      if (dragging) return;
      // Keyboard focus on a quote button may collapse the native selection.
      if (document.activeElement?.closest('[data-quote-action]')) return;
      saved.current = readSelection(session);
      setSelection(saved.current);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const down = (event: PointerEvent) => {
      dragging = true;
      if (!(event.target as Element).closest?.('[data-quote-action]')) setSelection(null);
    };
    const up = () => { dragging = false; schedule(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { saved.current = null; setSelection(null); cancelAnimationFrame(frame); }
      else schedule();
    };
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.target as Element).closest?.('input,textarea,[contenteditable]') && !event.defaultPrevented && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyQ' && (readSelection(session) ?? saved.current)?.session === session) {
        event.preventDefault(); quote();
      }
    };
    document.addEventListener('keydown', shortcut);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keyup', key);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', shortcut);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keyup', key);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [session, enabled, quote]);
  return {
    quote,
    toolbar: enabled && selection?.session === session ? <button
      type="button" className="quote-selection-button" data-quote-action
      style={{left: selection.left, top: selection.top}}
      onPointerDown={event=>event.preventDefault()} onClick={()=>quote()}
      aria-label="Quote selected text" aria-keyshortcuts="Alt+Q" title="Quote selection (Alt/Option+Q)">
      <QuoteIcon /> Quote
    </button> : null,
  };
}

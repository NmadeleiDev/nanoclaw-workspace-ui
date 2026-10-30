import React, { useCallback, useEffect, useRef, useState } from 'react';

export type DocumentQuoteSource = {
  sessionId?: string;
  documentId: string;
  name: string;
  revision: string;
  path?: string;
  attachmentId?: string;
  unsaved?: boolean;
  page?: number;
};
export function appendQuote(draft: string, selectedText: string): string {
  const text = selectedText.replace(/\r\n?/g, '\n').trim();
  if (!text) return draft;
  const gap = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
  return (
    draft +
    gap +
    text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n') +
    '\n\n'
  );
}
export type DraftQuote = { id: string; text: string; source?: DocumentQuoteSource };
/** Keep rich composer state separate from the plain text sent through the chat transport. */
export function serializeQuotedMessage(reply: string, quotes: DraftQuote[]): string {
  if (!quotes.length) return reply;
  const blocks = quotes
    .filter((q) => q.text.trim())
    .map((q) => {
      const source = q.source;
      let label = '';
      if (source) {
        const name = source.name.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');
        const caption = `Quoted from ${name}${source.page ? ` · page ${source.page}` : ''}${source.unsaved ? ' · unsaved draft' : ''}`;
        const detail = `${source.path ? `Working file: ${source.path}` : `Attachment: ${source.attachmentId}`}; document ID: ${source.documentId}; revision: ${source.revision}`;
        label = source.sessionId
          ? `[${caption}](/api/sessions/${encodeURIComponent(source.sessionId)}/documents/${encodeURIComponent(source.documentId)} ${JSON.stringify(detail)})\n\n`
          : `${caption}\n\n`;
      }
      return label + appendQuote('', q.text).trimEnd();
    });
  return blocks.join('\n\n') + (reply.trim() ? '\n\n' + reply : '');
}
export function parseDraftQuotes(raw: string | null): DraftQuote[] {
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.some(
      (q) =>
        !q ||
        typeof q.id !== 'string' ||
        typeof q.text !== 'string' ||
        (q.source &&
          (['name', 'documentId', 'revision'].some((key) => typeof q.source[key] !== 'string') ||
            ['sessionId', 'path', 'attachmentId'].some(
              (key) => q.source[key] !== undefined && typeof q.source[key] !== 'string',
            ))),
    )
  )
    throw new Error('Stored quotes could not be read.');
  return value;
}
export function ComposerQuotes({
  quotes,
  onRemove,
  disabled,
}: {
  quotes: DraftQuote[];
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!quotes.length) return null;
  return (
    <div className="composer-quotes" aria-label="Quoted passages">
      {quotes.map((quote) => (
        <div className="composer-quote" key={quote.id}>
          <div className="composer-quote-heading">
            <QuoteIcon />
            <span title={quote.source?.path || quote.source?.name}>
              {quote.source?.name || 'Quoted message'}
              {quote.source?.page ? ` · page ${quote.source.page}` : ''}
              {quote.source?.unsaved ? ' · unsaved draft' : ''}
            </span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove quote${quote.source ? ` from ${quote.source.name}` : ''}`}
              onClick={() => onRemove(quote.id)}
            >
              ×
            </button>
          </div>
          <blockquote className={expanded[quote.id] ? 'expanded' : ''}>{quote.text}</blockquote>
          {(quote.text.length > 450 || quote.text.split('\n').length > 5) && (
            <button
              type="button"
              className="composer-quote-expand"
              aria-expanded={!!expanded[quote.id]}
              onClick={() => setExpanded((old) => ({ ...old, [quote.id]: !old[quote.id] }))}
            >
              {expanded[quote.id] ? 'Show less' : 'Show full quote'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
export const QuoteIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <path d="M4 12h5v7H3v-7c0-4 2-6 6-7M16 12h5v7h-6v-7c0-4 2-6 6-7" />
  </svg>
);
type QuoteSelection = {
  session: string;
  messageId: string;
  text: string;
  left: number;
  top: number;
  document?: DocumentQuoteSource;
};
function sourceOf(node: Node | null): Element | null {
  return (node instanceof Element ? node : node?.parentElement)?.closest('[data-quote-source]') ?? null;
}
/** A quote must remain within one message or one document revision. */
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
  let documentSource: DocumentQuoteSource | undefined;
  const documentRaw = source.getAttribute('data-quote-document');
  if (documentRaw) {
    try {
      documentSource = JSON.parse(documentRaw);
    } catch {
      return null;
    }
    if (
      !documentSource ||
      !['documentId', 'name', 'revision'].every(
        (key) => typeof (documentSource as Record<string, unknown>)[key] === 'string',
      ) ||
      (!documentSource.path && !documentSource.attachmentId)
    )
      return null;
    documentSource = { ...documentSource, sessionId: session };
    const page = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
      ?.closest('[data-document-page]')
      ?.getAttribute('data-document-page');
    if (page) documentSource = { ...documentSource, page: Number(page) };
  }
  const actionWidth = Math.max(164, parseFloat(getComputedStyle(document.documentElement).fontSize) * 8);
  return {
    session,
    document: documentSource,
    messageId: source.getAttribute('data-quote-source')!,
    text,
    left: Math.max(12, Math.min(rect.left, window.innerWidth - actionWidth - 12)),
    top: Math.max(8, Math.min(rect.top >= 56 ? rect.top - 52 : rect.bottom + 8, window.innerHeight - 56)),
  };
}
export function useMessageQuotes(
  session: string,
  enabled: boolean,
  onQuote: (text: string, source?: DocumentQuoteSource) => boolean,
) {
  const [selection, setSelection] = useState<QuoteSelection | null>(null);
  const saved = useRef<QuoteSelection | null>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  const dismiss = useCallback(() => {
    saved.current = null;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);
  const quote = useCallback(
    (message?: { id: string; text: string }) => {
      if (!enabled) return;
      const current = readSelection(session) ?? saved.current;
      const text =
        current?.session === session && (!message || current.messageId === message.id) ? current.text : message?.text;
      if (
        text &&
        onQuoteRef.current(
          text,
          current?.session === session && (!message || current.messageId === message.id) ? current.document : undefined,
        )
      ) {
        dismiss();
      }
    },
    [enabled, session, dismiss],
  );
  useEffect(() => {
    saved.current = null;
    setSelection(null);
    if (!enabled) return;
    let frame = 0,
      dragging = false;
    const update = () => {
      if (dragging) return;
      // Keyboard focus on a quote button may collapse the native selection.
      if (document.activeElement?.closest('[data-quote-action]')) return;
      saved.current = readSelection(session);
      setSelection(saved.current);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const down = (event: PointerEvent) => {
      dragging = true;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-quote-action]')) return;
      const nativeSelection = window.getSelection();
      const source = sourceOf(nativeSelection?.anchorNode ?? null);
      // iOS can retain a native selection after a tap outside its message.
      // Leave touches within the source alone so selection handles still work.
      if ((source && source !== sourceOf(target)) || (!source && saved.current)) dismiss();
      else setSelection(null);
    };
    const up = () => {
      dragging = false;
      schedule();
    };
    const shortcut = (event: KeyboardEvent) => {
      if (
        !(event.target as Element).closest?.('input,textarea,[contenteditable]') &&
        !event.defaultPrevented &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === 'KeyQ' &&
        (readSelection(session) ?? saved.current)?.session === session
      ) {
        event.preventDefault();
        quote();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (saved.current || readSelection(session))) {
        dismiss();
        cancelAnimationFrame(frame);
      } else shortcut(event);
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keyup', schedule);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keyup', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [session, enabled, quote, dismiss]);
  return {
    quote,
    toolbar:
      enabled && selection?.session === session ? (
        <div
          className="quote-selection-button"
          data-quote-action
          role="group"
          aria-label="Text selection"
          style={{ left: selection.left, top: selection.top }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => quote()}
            aria-label={selection.document ? 'Quote selected document text' : 'Quote selected text'}
            aria-keyshortcuts="Alt+Q"
            title="Quote selection (Alt/Option+Q)"
          >
            <QuoteIcon /> Quote
          </button>
          <button type="button" onClick={dismiss} aria-label="Clear text selection" title="Clear selection">
            ×
          </button>
        </div>
      ) : null,
  };
}

import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { appendQuote, serializeQuotedMessage, parseDraftQuotes, ComposerQuotes } from '../src/quotes';
it('quotes a selection as Markdown and leaves a blank line for the reply', () => {
  expect(appendQuote('', 'DIN-1873 — review the dashboard.')).toBe('> DIN-1873 — review the dashboard.\n\n');
  expect(appendQuote('', 'First line\r\n\r\nSecond line')).toBe('> First line\n>\n> Second line\n\n');
});
it('keeps the existing draft, separates successive quotes, and preserves Unicode', () => {
  expect(appendQuote('My existing draft', 'Первая строка 😀')).toBe('My existing draft\n\n> Первая строка 😀\n\n');
  expect(appendQuote('Draft\n', 'Quote')).toBe('Draft\n\n> Quote\n\n');
  expect(appendQuote('Draft\n\n', 'Quote')).toBe('Draft\n\n> Quote\n\n');
  expect(appendQuote(appendQuote('', 'One'), 'Two')).toBe('> One\n\n> Two\n\n');
  expect(appendQuote('Keep this', ' \n ')).toBe('Keep this');
});

it('serializes styled composer quotes without changing the reply text', () => {
  const quotes = [
    { id: 'one', text: 'A passage' },
    { id: 'two', text: 'Another passage' },
  ];
  expect(serializeQuotedMessage('My reply', quotes)).toBe('> A passage\n\n> Another passage\n\nMy reply');
  expect(serializeQuotedMessage('', quotes)).toBe('> A passage\n\n> Another passage');
  expect(serializeQuotedMessage('Keep my exact text\n', [])).toBe('Keep my exact text\n');
});
it('keeps document provenance in a readable source link sent to the agent', () => {
  const source = {
    sessionId: 'session-one',
    documentId: 'abc123',
    name: 'spec.md',
    path: '/work/spec.md',
    revision: 'rev-3',
    page: 2,
    unsaved: true,
  };
  const text = serializeQuotedMessage('Why?', [{ id: 'quote', text: 'Selected text', source }]);
  expect(text).toContain('[Quoted from spec.md · page 2 · unsaved draft](/api/sessions/session-one/documents/abc123');
  expect(text).toContain('Working file: /work/spec.md');
  expect(text).toContain('revision: rev-3');
  expect(text).toContain('> Selected text\n\nWhy?');
});
it('restores quote drafts and rejects malformed persisted data', () => {
  const quotes = [
    {
      id: 'quote-one',
      text: 'Passage',
      source: { documentId: 'abc', name: 'spec.md', path: '/work/spec.md', revision: 'rev' },
    },
  ];
  expect(parseDraftQuotes(JSON.stringify(quotes))).toEqual(quotes);
  expect(parseDraftQuotes(null)).toEqual([]);
  expect(() => parseDraftQuotes('{}')).toThrow('Stored quotes');
  expect(() => parseDraftQuotes('[{"id":"a"}]')).toThrow('Stored quotes');
});

it('identifies attachments and safely renders document labels with line breaks', () => {
  const text = serializeQuotedMessage('Reply', [
    {
      id: 'q',
      text: 'Excerpt',
      source: { sessionId: 'one', name: 'a\n> spoof.md', documentId: 'abc', attachmentId: 'file-123', revision: 'rev' },
    },
  ]);
  expect(text).toContain('[Quoted from a > spoof.md]');
  expect(text).toContain('Attachment: file-123');
  expect(text).toContain('> Excerpt\n\nReply');
});

it('renders quote blocks in the composer and keeps provenance out of visible message text', () => {
  const quote = {
    id: 'quote',
    text: 'A selected passage',
    source: {
      sessionId: 'one',
      documentId: 'abc123',
      name: 'spec.md',
      path: '/work/spec.md',
      revision: 'revision-hidden',
    },
  };
  const composer = renderToStaticMarkup(
    createElement(ComposerQuotes, { quotes: [quote], disabled: false, onRemove: () => {} }),
  );
  expect(composer).toContain('<blockquote');
  expect(composer).toContain('A selected passage');
  expect(composer).not.toContain('revision-hidden');
  expect(composer).not.toContain('&gt; A selected passage');
  const message = renderToStaticMarkup(
    createElement(Markdown, { children: serializeQuotedMessage('My reply', [quote]) }),
  );
  expect(message).toContain('href="/api/sessions/one/documents/abc123"');
  expect(message).toContain('revision-hidden');
  const visible = message.replace(/<[^>]*>/g, '');
  expect(visible).toContain('Quoted from spec.md');
  expect(visible).toContain('My reply');
  expect(visible).not.toContain('revision-hidden');
});

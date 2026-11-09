import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
}));
import { HtmlPreview, Binary } from '../src/document-viewer';

it('offers inline video controls without autoplay and preserves image previews', () => {
  const video = renderToStaticMarkup(
    React.createElement(Binary, { url: '/content', kind: 'video', name: 'clip.mp4', mime: 'video/mp4' }),
  );
  expect(video).toContain('<video');
  expect(video).toContain('controls=""');
  expect(video).toContain('playsInline=""');
  expect(video).not.toContain('autoPlay');
  const image = renderToStaticMarkup(
    React.createElement(Binary, { url: '/content', kind: 'image', name: 'photo.png', mime: 'image/png' }),
  );
  expect(image).toContain('<img');
  expect(image).toContain('alt="photo.png"');
});

it('renders full pages in an opaque sandbox rather than inheriting the app CSP via srcdoc', () => {
  const markup = renderToStaticMarkup(
    React.createElement(HtmlPreview, { html: '<script>play()</script>', name: 'game.html' }),
  );
  expect(markup).toContain('title="Preview game.html"');
  expect(markup).toContain('src="/api/document-preview"');
  expect(markup).toContain('sandbox="allow-scripts"');
  expect(markup).not.toContain('allow-same-origin');
  expect(markup).not.toContain('srcDoc');
  expect(markup).not.toContain('play()');
});

it('sends the complete draft only on the first load, never after page navigation', () => {
  const html =
    '<!doctype html><html><head><style>body{margin:0}</style></head><body><script>play()</script></body></html>';
  const frame = HtmlPreview({ html, name: 'game.html' });
  const postMessage = vi.fn();
  const event = { currentTarget: { contentWindow: { postMessage } } };
  frame.props.onLoad(event);
  expect(postMessage).toHaveBeenCalledWith({ type: 'workspace-html-preview', html }, '*');
  frame.props.onLoad(event);
  expect(postMessage).toHaveBeenCalledTimes(1);
});

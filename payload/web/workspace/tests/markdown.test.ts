import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceMarkdown } from '../src/markdown';

it('keeps the code-block component type stable across parent updates and fresh caller renderers', () => {
  const codeBlockType = (text: string) => {
    let element: React.ReactElement<any> = WorkspaceMarkdown({
      children: text,
      components: {
        a: ({ children }) => React.createElement('a', null, children),
        pre: ({ children }) => React.createElement('pre', { className: 'custom' }, children),
      },
    });
    while (!element.props.remarkPlugins) element = element.props.children;
    return element.props.components.pre;
  };
  const before = codeBlockType('```mermaid\nflowchart LR\n A-->B\n```');
  expect(codeBlockType('```mermaid\nflowchart LR\n A-->B\n```')).toBe(before);
  // Streaming surrounding text must not remount an unchanged diagram either.
  expect(codeBlockType('```mermaid\nflowchart LR\n A-->B\n```\n\nMore text')).toBe(before);
});
const render = (children: string) => renderToStaticMarkup(React.createElement(WorkspaceMarkdown, { children }));
it('recognizes Mermaid fences without nesting a diagram inside pre', () => {
  const html = render('Before\n\n```mermaid\nflowchart LR\n A-->B\n```\n\nAfter');
  expect(html).toContain('aria-label="Mermaid diagram"');
  expect(html).toContain('Copy source');
  expect(html).not.toContain('<pre>');
  expect(html).toContain('Before');
  expect(html).toContain('After');
});
it('preserves regular code, inline code, tables, and escapes HTML', () => {
  const html = render('`mermaid`\n\n```js\nconst x = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>');
  expect(html).toContain('language-js');
  expect(html).toContain('<table>');
  expect(html).not.toContain('mermaid-block');
  expect(html).not.toContain('<script>');
});
it('preserves caller link and code renderers', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceMarkdown, { children: '[file](file.md)\n\n```txt\nhello\n```', components: { a: ({ children }) => React.createElement('button', null, children), pre: ({ children }) => React.createElement('pre', { className: 'custom' }, children) } }));
  expect(html).toContain('<button>file</button>');
  expect(html).toContain('class="custom"');
});

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function DiagramIcon({ name }: { name: 'expand' | 'source' | 'copy' | 'close' }) {
  const paths = {
    expand: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
    source: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
    copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
    close: 'm6 6 12 12M18 6 6 18',
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [appearance, setAppearance] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const observer = new MutationObserver(() => setAppearance(n => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-preset'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let current = true;
    setSvg(''); setError('');
    const timer = setTimeout(() => {
      const render = async () => {
        if (!current) return;
        try {
          const { default: mermaid } = await import('mermaid');
          const colors = getComputedStyle(document.documentElement);
          const color = (name: string) => colors.getPropertyValue(name).trim();
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
            suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500,
            secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS'],
            theme: 'base', themeVariables: { darkMode: document.documentElement.dataset.theme !== 'light',
              background: color('--bg'), primaryColor: color('--surface-2'), primaryTextColor: color('--text'),
              primaryBorderColor: color('--accent'), lineColor: color('--muted'), secondaryColor: color('--surface'), tertiaryColor: color('--surface-3') } });
          const result = await mermaid.render(`workspace-mermaid-${++nextId}`, source);
          if (current) setSvg(result.svg);
        } catch { if (current) setError('Unable to render Mermaid diagram. Check the source.'); }
      };
      queue = queue.then(render, render);
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [source, appearance]);
  const diagram = <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />;
  return <section className="mermaid-block" aria-label="Mermaid diagram" data-quote-exclude="true">
    <div className="mermaid-controls">
      <button type="button" aria-label="Expand diagram" title="Expand diagram" disabled={!svg} onClick={() => { setExpanded(true); dialog.current?.showModal(); }}><DiagramIcon name="expand" /></button>
      <button type="button" aria-label="Show source" title="Show source" aria-expanded={showSource} aria-pressed={showSource} onClick={() => setShowSource(v => !v)}><DiagramIcon name="source" /></button>
      <button type="button" aria-label="Copy source" title="Copy source" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(source)).then(() => setCopyStatus('Copied'), () => setCopyStatus('Could not copy source')); }}><DiagramIcon name="copy" /></button>
      <span role="status">{copyStatus}</span>
    </div>
    {error ? <p role="status">{error}</p> : svg ? (expanded ? null : diagram) : <p role="status">Rendering diagram…</p>}
    {(showSource || error) && <pre><code>{source}</code></pre>}
    <dialog ref={dialog} className="mermaid-expanded" onClose={() => setExpanded(false)} aria-label="Expanded Mermaid diagram">
      <button type="button" className="mermaid-close" aria-label="Close expanded diagram" title="Close" onClick={() => dialog.current?.close()}><DiagramIcon name="close" /></button>
      {expanded && diagram}
    </dialog>
  </section>;
}

const PreRenderer = createContext<Components['pre']>(undefined);

// React reconciles by component type. Keep this outside WorkspaceMarkdown so
// polling/streaming updates don't remount diagrams and collapse their height.
function MarkdownBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  const Pre = useContext(PreRenderer) as React.ComponentType<React.ComponentProps<'pre'>> | undefined;
  const child = React.Children.toArray(children)[0];
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) && /(?:^|\s)language-mermaid(?:\s|$)/i.test(child.props.className ?? '')) {
    return <Mermaid source={String(child.props.children ?? '').replace(/\n$/, '')} />;
  }
  return Pre ? <Pre {...props}>{children}</Pre> : <pre {...props}>{children}</pre>;
}

export function WorkspaceMarkdown({ children, components = {} }: { children: string; components?: Components }) {
  return <PreRenderer.Provider value={components.pre}>
    <Markdown remarkPlugins={[remarkGfm]} components={{ ...components, pre: MarkdownBlock }}>{children}</Markdown>
  </PreRenderer.Provider>;
}

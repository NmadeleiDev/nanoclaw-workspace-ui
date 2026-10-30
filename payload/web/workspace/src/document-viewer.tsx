import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type * as PdfTypes from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type Doc = {
  id: string;
  name: string;
  kind: string;
  revision: string;
  editable: boolean;
  text?: string;
  size: number;
  source: { path?: string; attachmentId?: string };
};
type Tab = { doc: Doc; draft?: string; error?: string; conflict?: boolean; editing?: boolean; scroll?: number };
const states = new Map<string, { tabs: Tab[]; active: string; visible: boolean }>();
export function openDocument(session: string, attachmentId: string) {
  window.dispatchEvent(new CustomEvent('workspace-document-open', { detail: { session, attachmentId } }));
}
function DocumentGlyph({ kind }: { kind?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      {kind === 'image' ? (
        <path d="m7 17 3-4 3 3 2-2 2 3" />
      ) : (
        <>
          <path d="M8 13h8M8 17h5" />
        </>
      )}
    </svg>
  );
}
function Pdf({ data }: { data: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let task: PdfTypes.PDFDocumentLoadingTask | undefined;
    let render: PdfTypes.RenderTask | undefined;
    void import('pdfjs-dist')
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        task = pdfjs.getDocument({ data: data.slice() });
        return task.promise;
      })
      .then(async (pdf) => {
        setPages(pdf.numPages);
        const p = await pdf.getPage(Math.min(page, pdf.numPages));
        if (disposed) return;
        const fit = Math.min(1, (host.current?.clientWidth || 600) / p.getViewport({ scale: 1 }).width);
        const viewport = p.getViewport({ scale: zoom * fit });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.setAttribute('aria-label', `PDF page ${page}`);
        const sheet = document.createElement('div');
        sheet.className = 'pdf-page';
        sheet.setAttribute('data-document-page', String(page));
        sheet.style.width = `${viewport.width}px`;
        sheet.style.height = `${viewport.height}px`;
        sheet.style.setProperty('--total-scale-factor', String(viewport.scale));
        sheet.append(canvas);
        host.current?.replaceChildren(sheet);
        render = p.render({ canvas, viewport });
        await render.promise;
        const content = await p.getTextContent();
        if (disposed) return;
        const text = document.createElement('div');
        text.className = 'textLayer';
        sheet.append(text);
        const { TextLayer } = await import('pdfjs-dist');
        await new TextLayer({ textContentSource: content, container: text, viewport }).render();
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      render?.cancel();
      void task?.destroy();
    };
  }, [data, page, zoom]);
  return (
    <>
      <div className="document-toolbar">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>+</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="pdf-pages" ref={host} />
    </>
  );
}
function Binary({ url, kind, name }: { url: string; kind: string; name: string }) {
  const [bytes, setBytes] = useState<Uint8Array>(),
    [src, setSrc] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let object = '';
    void fetch(url, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Document unavailable.');
        const data = new Uint8Array(await r.arrayBuffer());
        if (kind === 'pdf') setBytes(data);
        else {
          const ext = name.split('.').at(-1)?.toLowerCase();
          object = URL.createObjectURL(new Blob([data], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }));
          setSrc(object);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => {
      abort.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [url, kind, name]);
  return error ? (
    <p role="alert">{error}</p>
  ) : kind === 'pdf' ? (
    bytes ? (
      <Pdf data={bytes} />
    ) : (
      <p>Loading…</p>
    )
  ) : (
    <img className="document-image" src={src || undefined} alt={name} />
  );
}
function DocumentImage({
  src,
  alt,
  source,
  base,
  api,
}: {
  src?: string;
  alt?: string;
  source?: string;
  base: string;
  api: <T = any>(url: string, method?: string, body?: unknown) => Promise<T>;
}) {
  const [doc, setDoc] = useState<Doc>(),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!src || !source || /^[a-z]+:|^\/\//i.test(src)) {
      setError('External image');
      return;
    }
    void api<Doc>(base.replace(/^\/api/, ''), 'POST', { path: source.replace(/[^/]+$/, '') + decodeURIComponent(src) })
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src, source, base]);
  return doc?.kind === 'image' ? (
    <Binary url={`${base}/${doc.id}/content`} kind="image" name={doc.name} />
  ) : (
    <span role={error ? 'status' : undefined}>
      {alt || 'Image'}
      {error ? `: ${error}` : '…'}
    </span>
  );
}
export function DocumentViewer({
  session,
  onVisibility,
  onContext,
  api,
}: {
  session: string;
  api: <T = any>(url: string, method?: string, body?: unknown) => Promise<T>;
  onVisibility: (v: boolean) => void;
  onContext: () => void;
}) {
  const request = <T,>(url: string, method = 'GET', body?: unknown) => api<T>(url.replace(/^\/api/, ''), method, body);
  const [, redraw] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<{ id: string; action: string }>();
  const [error, setError] = useState('');
  const [width, setWidth] = useState(Number(localStorage.getItem('ws.document-width')) || 640);
  const busy = useRef(false);
  if (!states.has(session)) {
    let stored: any = {};
    try {
      stored = JSON.parse(localStorage.getItem(`ws.documents:${session}`) || '{}');
    } catch {}
    states.set(session, { tabs: [], active: stored.active || '', visible: false });
  }
  useEffect(() => {
    localStorage.setItem('ws.document-width', String(width));
  }, [width]);
  const state = states.get(session)!;
  const base = `/api/sessions/${session}/documents`;
  const active = state.tabs.find((t) => t.doc.id === state.active);
  const dirty = (t: Tab) => t.draft !== undefined && t.draft !== t.doc.text;
  const update = () => {
    redraw((n) => n + 1);
    localStorage.setItem(
      `ws.documents:${session}`,
      JSON.stringify({ ids: state.tabs.map((t) => t.doc.id), active: state.active, visible: state.visible }),
    );
    onVisibility(state.visible);
  };
  const focus = async (id: string, action = 'open') => {
    if (state.tabs.some((t) => t.doc.id === state.active && dirty(t)) && id !== state.active) {
      setPending({ id, action });
      return;
    }
    try {
      const doc = await request<Doc>(`${base}/${id}`);
      setError('');
      const old = state.tabs.find((t) => t.doc.id === id);
      if (old) {
        if (!dirty(old)) {
          old.doc = doc;
          old.draft = undefined;
        } else if (old.doc.revision !== doc.revision) old.conflict = true;
      } else state.tabs.push({ doc });
      if (action !== 'refresh') {
        state.active = id;
        state.visible = true;
      }
      update();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    let cancelled = false;
    let saved: any = {};
    try {
      saved = JSON.parse(localStorage.getItem(`ws.documents:${session}`) || '{}');
    } catch {}
    if (!state.tabs.length)
      void Promise.all(
        (saved.ids || []).map((id: string) =>
          request<Doc>(`${base}/${id}`)
            .then((doc) => ({ doc }))
            .catch(() => null),
        ),
      ).then((tabs) => {
        if (cancelled) return;
        state.tabs = tabs.filter(Boolean) as Tab[];
        state.visible = !!saved.visible && !!state.tabs.length;
        update();
      });
    else onVisibility(state.visible);
    const open = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.session !== session) return;
      if (d.documentId) {
        void focus(d.documentId);
        return;
      }
      void request<Doc>(base, 'POST', { attachmentId: d.attachmentId })
        .then((doc) => focus(doc.id))
        .catch((e) => setError(String(e)));
    };
    window.addEventListener('workspace-document-open', open);
    const quoted = (event: Event) => {
      if ((event as CustomEvent).detail.session !== session) return;
      if (window.matchMedia('(max-width:900px)').matches || document.querySelector('.document-drawer.expanded')) {
        state.visible = false;
        update();
      }
    };
    window.addEventListener('workspace-document-quoted', quoted);
    const unload = (e: BeforeUnloadEvent) => {
      if ([...states.values()].some((s) => s.tabs.some(dirty))) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      cancelled = true;
      window.removeEventListener('workspace-document-open', open);
      window.removeEventListener('workspace-document-quoted', quoted);
      window.removeEventListener('beforeunload', unload);
    };
  }, [session]);
  const latest = useRef({ focus, update, dirty });
  latest.current = { focus, update, dirty };
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.hidden || busy.current) return;
      busy.current = true;
      try {
        const listing = await request<{ requests: { seq: number; action: string; document_id: string }[] }>(base);
        if (stopped) return;
        const key = `ws.document-cursor:${session}`;
        const saved = localStorage.getItem(key);
        const cursor = saved === null ? Math.max(0, ...listing.requests.map((e) => e.seq)) : Number(saved);
        if (saved === null) localStorage.setItem(key, String(cursor));
        for (const event of listing.requests) {
          if (event.seq <= cursor) continue;
          await latest.current.focus(event.document_id, event.action);
          if (stopped) return;
          localStorage.setItem(key, String(event.seq));
        }
        for (const tab of state.tabs) {
          const doc = await request<Doc>(`${base}/${tab.doc.id}`);
          if (stopped) return;
          if (doc.revision !== tab.doc.revision) {
            if (latest.current.dirty(tab)) tab.conflict = true;
            else {
              tab.doc = doc;
              tab.draft = undefined;
            }
            latest.current.update();
          }
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      } finally {
        busy.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session]);
  const save = async () => {
    if (!active || active.conflict || !dirty(active)) return;
    try {
      active.doc = await request<Doc>(`${base}/${active.doc.id}`, 'PUT', {
        text: active.draft,
        revision: active.doc.revision,
      });
      active.draft = undefined;
      active.error = undefined;
      update();
    } catch (e) {
      active.error = String(e);
      update();
    }
  };
  const openRelative = async (href: string) => {
    if (!active?.doc.source.path) return;
    try {
      const directory = active.doc.source.path.replace(/[^/]+$/, '');
      const doc = await request<Doc>(base, 'POST', { path: directory + decodeURIComponent(href.split('#')[0]) });
      await focus(doc.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.visible) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [session]);
  const reopenTarget = document.getElementById('document-reopen-slot');
  if (!state.visible)
    return reopenTarget
      ? createPortal(
          <>
            {state.tabs.length > 0 && (
              <button
                className="document-reopen"
                aria-label={`Documents (${state.tabs.length})`}
                title="Open documents"
                onClick={() => {
                  state.visible = true;
                  update();
                }}
              >
                <DocumentGlyph />
                <span className="document-reopen-label">Documents</span>
                <span>{state.tabs.length}</span>
              </button>
            )}
            {error && (
              <button className="document-reopen" onClick={() => setError('')} role="alert">
                {error}
              </button>
            )}
          </>,
          reopenTarget,
        )
      : null;
  return (
    <aside
      className={`document-drawer ${expanded ? 'expanded' : ''}`}
      style={{ width: expanded ? 'calc(100vw - 60px)' : width }}
      aria-label="Document viewer"
    >
      <div
        className="document-resize"
        role="separator"
        aria-label="Resize documents"
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            setWidth((w) => Math.max(360, Math.min(innerWidth - 300, w + (e.key === 'ArrowLeft' ? 40 : -40))));
          }
        }}
        onPointerDown={(e) => {
          const start = e.clientX,
            initial = width;
          const move = (ev: PointerEvent) =>
            setWidth(Math.max(360, Math.min(innerWidth - 300, initial + start - ev.clientX)));
          const end = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', end);
        }}
      />
      <header>
        <strong>
          <DocumentGlyph />
          Documents
        </strong>
        <button
          onClick={() => {
            state.visible = false;
            update();
            onContext();
          }}
        >
          Context
        </button>
        <button onClick={() => setExpanded((v) => !v)}>{expanded ? 'Restore' : 'Expand'}</button>
        <button
          aria-label="Close document drawer"
          onClick={() => {
            state.visible = false;
            localStorage.setItem('ws.document-width', String(width));
            update();
          }}
        >
          ×
        </button>
      </header>
      <div className="document-tabs" role="tablist" aria-label="Open documents">
        {state.tabs.map((t, i) => (
          <div key={t.doc.id} className={`document-tab ${t.doc.id === state.active ? 'active' : ''}`}>
            <button
              role="tab"
              aria-selected={t.doc.id === state.active}
              tabIndex={t.doc.id === state.active ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  state.active =
                    state.tabs[(i + (e.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length].doc.id;
                  update();
                  e.currentTarget
                    .closest('[role=tablist]')
                    ?.querySelectorAll<HTMLElement>('[role=tab]')
                    [state.tabs.findIndex((tab) => tab.doc.id === state.active)]?.focus();
                }
              }}
              onClick={() => {
                state.active = t.doc.id;
                update();
              }}
              title={t.doc.source.path || t.doc.name}
            >
              <DocumentGlyph kind={t.doc.kind} />
              <span>{t.doc.name}</span>
              {dirty(t) && <i className="document-dirty" aria-label="Unsaved changes" />}
            </button>
            <button
              className="document-tab-close"
              aria-label={`Close ${t.doc.name}`}
              onClick={() => {
                if (dirty(t) && !confirm('Discard unsaved changes?')) return;
                state.tabs = state.tabs.filter((x) => x !== t);
                if (state.active === t.doc.id) state.active = state.tabs.at(-1)?.doc.id || '';
                if (!state.tabs.length) state.visible = false;
                update();
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {pending && (
        <button
          onClick={() => {
            if (active && dirty(active)) return;
            void focus(pending.id, pending.action);
            setPending(undefined);
          }}
        >
          Agent opened a document · {active && dirty(active) ? 'Save or discard edits to view' : 'View'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {active && (
        <>
          <div className="document-toolbar">
            <span title={active.doc.source.path}>{active.doc.source.path || 'Attachment'}</span>
            {active.doc.editable && (
              <>
                <button
                  onClick={() => {
                    active.editing = !active.editing;
                    update();
                  }}
                >
                  {active.editing ? 'Preview' : 'Edit'}
                </button>
                <button
                  className="document-save"
                  disabled={!dirty(active) || active.conflict}
                  onClick={() => void save()}
                >
                  Save
                </button>
              </>
            )}
            <button onClick={() => void focus(active.doc.id, 'refresh')}>Refresh</button>
            <a href={`${base}/${active.doc.id}/content`} download={active.doc.name}>
              Download
            </a>
          </div>
          {(active.conflict || active.error) && (
            <div role="alert" className="document-conflict">
              {active.error || 'File changed on disk. Your draft is preserved.'}
              <button
                onClick={() => void navigator.clipboard.writeText(active.draft || '').catch((e) => setError(String(e)))}
              >
                Copy draft
              </button>
              <button
                onClick={() => {
                  if (dirty(active) && !confirm('Discard this draft and load the latest file?')) return;
                  active.draft = undefined;
                  active.conflict = false;
                  active.error = undefined;
                  void focus(active.doc.id, 'refresh');
                }}
              >
                Reload latest
              </button>
            </div>
          )}
          <div
            className="document-body"
            data-quote-source={
              !active.editing && ['markdown', 'text', 'pdf'].includes(active.doc.kind)
                ? `document:${session}:${active.doc.id}:${active.doc.revision}:${dirty(active) ? 'draft' : 'saved'}`
                : undefined
            }
            data-quote-document={JSON.stringify({
              documentId: active.doc.id,
              name: active.doc.name,
              revision: active.doc.revision,
              ...active.doc.source,
              unsaved: dirty(active),
            })}
            key={active.doc.id}
            ref={(el) => {
              if (el && active.scroll !== undefined) el.scrollTop = active.scroll;
            }}
            onScroll={(e) => {
              active.scroll = e.currentTarget.scrollTop;
            }}
          >
            {active.editing ? (
              <textarea
                aria-label={`Edit ${active.doc.name}`}
                value={active.draft ?? active.doc.text ?? ''}
                onChange={(e) => {
                  active.draft = e.target.value;
                  update();
                }}
              />
            ) : active.doc.kind === 'markdown' && active.doc.text !== undefined ? (
              <div className="markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          if (href && !/^[a-z]+:|^\/\/|^#/.test(href) && active.doc.source.path) {
                            e.preventDefault();
                            void openRelative(href);
                          }
                        }}
                      >
                        {children}
                      </a>
                    ),
                    img: ({ src, alt }) => (
                      <DocumentImage src={src} alt={alt} source={active.doc.source.path} base={base} api={api} />
                    ),
                  }}
                >
                  {active.draft ?? active.doc.text}
                </Markdown>
              </div>
            ) : active.doc.kind === 'text' && active.doc.text !== undefined ? (
              <pre>{active.draft ?? active.doc.text}</pre>
            ) : ['pdf', 'image'].includes(active.doc.kind) ? (
              <Binary
                key={active.doc.revision}
                url={`${base}/${active.doc.id}/content?revision=${active.doc.revision}`}
                kind={active.doc.kind}
                name={active.doc.name}
              />
            ) : (
              <p>Preview unavailable for this format or size. Use Download.</p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

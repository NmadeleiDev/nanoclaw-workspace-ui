import { appendQuote, QuoteIcon, useMessageQuotes } from './quotes';
import { isToolOnly, messageGroups, liveActivityKey, activityGroupKey } from '../../../src/modules/workspace-ui/activity';
import { WorkspaceConnectionError, workspaceRequest } from './response';
import { SpeechButton, SpeechSettings, type SpeechConfig } from './speech';
import { resolveNavigation, navigationUrl, navigationKey } from './navigation';
import { matchImportAgents } from './import-mapping';
import { useChatAttachments, fileSize, transferFiles } from './attachments';
import './style.css';
import { PresetChoices, useWorkspaceAppearance, type WorkspaceAppearance } from './appearance';
import { AmbientBackground } from './ambient-background';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { directoryLabel } from '../../../src/modules/workspace-ui/path-label.js';

const AgentModelSettings = React.lazy(() => import('./agent-settings').then(m => ({default:m.AgentModelSettings})));
const ApiConnectionSettings = React.lazy(() => import('./agent-settings').then(m => ({default:m.ApiConnectionSettings})));

const HomeDirectory = React.createContext('');
function DirectoryPath({ path }: { path: string }) {
  const home = React.useContext(HomeDirectory);
  return <span className="directory-path" title={path}>{directoryLabel(path, home)}</span>;
}
import {
  Bell,
  DeviceAccess,
  configureNotificationTimezone,
  configureNotifications,
  useNotifications,
  useReadingPresence,
  identifyInstallation,
  ScopeNotifications,
  NotificationSettings,
  ActivityInbox,
  PairingCode,
  InstallApp,
  registerWorkspacePwa,
  type Target,
  type Activity,
} from './notifications';
import { formatLocalTime } from '../../../src/timezone.js';

type Project = { id: string; name: string; description: string; directories: Directory[]; archived: boolean };
type Directory = { id: string; path: string; readonly: boolean };
type Session = {
  latestMessage?: { role: 'user' | 'assistant'; text: string; sender: string | null; timestamp: string } | null;
  runtimeDriver?: string | null;
  id: string;
  agentId: string;
  projectId: string | null;
  title: string;
  origin: string;
  pinned: boolean;
  archived: boolean;
  nativeSessionId: string | null;
  directories: Directory[];
  primaryDirectoryId: string | null;
  model: string | null;
  effort: string | null;
  updatedAt: string;
};
type Agent = { id: string; name: string; provider: string; model: string; effort: string; folder: string; modelProviders?: Record<string,string>; modelProvider?: {id:string;label:string} | null };
function modelLabel(model: string | null | undefined, agent?: Agent) {
  if (!model) return 'Agent default';
  const slash = model.indexOf('/');
  if (slash < 0) return `${agent?.modelProvider?.label ?? agent?.provider ?? 'Model'} / ${model}`;
  const provider = model.slice(0, slash);
  return `${agent?.modelProviders?.[provider] ?? (agent?.modelProvider?.id === provider ? agent.modelProvider.label : provider)} / ${model.slice(slash + 1)}`;
}
function SessionModelPicker({ value, change, agent, agents, connections, validity }: {
  value: string; change: (value: string) => void; agent?: Agent; agents: Agent[]; connections: Bootstrap['modelConnections']; validity: (valid: boolean) => void;
}) {
  const models = [...new Set([...agents.filter(a => a.provider === agent?.provider).map(a => a.model).filter(Boolean), ...(agent?.provider === 'opencode' ? connections.flatMap(c=>c.models.map(m=>`${c.id}/${m.id}`)) : [])])];
  const [custom, setCustom] = useState(!!value && !models.includes(value));
  useEffect(() => { validity(!custom || !!value.trim()); }, [custom, value, validity]);
  return <div className="session-model-picker">
    <label>
      Model
      <select value={custom ? '__custom__' : value} aria-describedby="session-model-help" onChange={e => {
        const other = e.target.value === '__custom__';
        setCustom(other);
        change(other ? '' : e.target.value);
      }}>
        <option value="">Use agent default · {modelLabel(agent?.model, agent)}</option>
        <optgroup label="Configured models">
          {models.map(id => <option value={id} key={id}>{modelLabel(id, agent)}</option>)}
        </optgroup>
        <option value="__custom__">Other model…</option>
      </select>
    </label>
    {custom && <label className="custom-model-field">
      Custom model ID
      <input value={value} onChange={e => change(e.target.value)} placeholder={`${agent?.modelProvider?.id ?? 'provider'}/model`} required />
    </label>}
  </div>;
}
type Message = {
  id: string;
  role: string;
  text: string;
  timestamp: string;
  source: string;
  kind: string;
  files: { id: string; name: string; mime?: string }[];
  data?: { activityKey?: string; startedAt?: string; endedAt?: string; turnError?: string; tools?: { name: string; input: unknown; status?: string; output?: string; error?: string }[]; toolName?: string; sender?: string };
};
type Doc = { markdown: string; revision: number; author: string; updatedAt: string };
type Profile = { provider: 'ollama' | 'apple' | 'agent'; model?: string; endpoint?: string; agentId?: string };
type Settings = WorkspaceAppearance & {
  speech: SpeechConfig;
  utility: Profile;
  overrides: Record<string, Profile>;
  automaticSummaries: boolean;
  maintenanceAgentId: string | null;
  port: number;
};
type Bootstrap = {
  timezone: string;
  modelConnections: {id:string;name:string;models:{id:string;image:boolean}[]}[];
  homeDirectory: string;
  pending: Detail['pending'];
  documentVersions: Record<string, number>;
  agents: Agent[];
  projects: Project[];
  sessions: Session[];
  settings: Settings;
  runtime: { id: string; container_status: string; status: string }[];
  connected: boolean;
  csrf: string;
  jobs: { scope_id: string; task: string; state: string; error?: string }[];
};
type Detail = {
  activitySummaries?: Record<string, ActivitySummary>;
  session: Session;
  messages: Message[];
  next: string | null;
  live?: {
    archived?: boolean;
    startedAt?: string;
    updatedAt?: string;
    running: boolean;
    tools: Record<
      string,
      { id: string; name: string; status: string; input?: unknown; output?: string; error?: string }
    >;
    texts: Record<string, string>;
    error?: string;
  };
  pending: {
    id: string;
    type: string;
    title: string;
    question?: string;
    status?: string;
    options: (string | { label: string; value?: string })[];
  }[];
};

let csrf = '';
let displayTimezone = 'UTC';
async function api<T = any>(url: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  return workspaceRequest<T>(`/api${url}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Workspace-Csrf': csrf } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

configureNotifications(api);
registerWorkspacePwa();

const icons: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
    </>
  ),
  settings: (
    <>
      <path
        d="m9 3-.5 3-3 1L3 6l-2 4 2.5 2-.5 3 3 2 2.5-1 2 2 .5 3h4l.5-3 2.5-1 2.5 1 3-3-.5-3L24 10l-2-4-3 1-2.5-1-.5-3Z"
        transform="translate(1 1) scale(.88)"
      />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  note: (
    <>
      <path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" />,
  paperclip: <path d="m9 14 7-7a3 3 0 0 1 4 4L10 21a5 5 0 0 1-7-7L13 4a2 2 0 0 1 3 3L6 17" />,
  check: <path d="m5 12 4 4L19 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  pin: (
    <>
      <path d="m14 3 7 7-4 1-4 5-2-2-6 6M8 11l3-5V3" />
      <path d="m6 9 9 9" />
    </>
  ),
  archive: (
    <>
      <path d="M4 8h16v13H4Z" />
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M9 12h6" />
    </>
  ),
  unarchive: (
    <>
      <path d="M4 8h16v13H4Z" />
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M12 18v-7m-3 3 3-3 3 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
  edit: (
    <>
      <path d="m14 4 6 6-10 10H4v-6Z" />
      <path d="m12 6 6 6" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  shield: (
    <>
      <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'bell' ? (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </>
      ) : (
        (icons[name] ?? icons.chat)
      )}
    </svg>
  );
}
function IconButton({
  icon,
  label,
  tooltip,
  onClick,
  active,
  disabled,
}: {
  icon: string;
  label: string;
  tooltip?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      aria-label={label}
      title={tooltip ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );
}
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function Avatar({ agent, small = false }: { agent?: Agent; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? 'small' : ''}`}
      data-color={
        agent?.name.toLowerCase().includes('engineer')
          ? 'green'
          : agent?.name.toLowerCase().includes('market')
            ? 'orange'
            : agent?.name.toLowerCase().includes('product')
              ? 'blue'
              : 'purple'
      }
    >
      {agent?.name[0] ?? 'N'}
    </span>
  );
}
function ago(value: string) {
  if (!value) return '';
  const hours = (Date.now() - Date.parse(value)) / 3600_000;
  return hours < 1
    ? `${Math.max(1, Math.floor(hours * 60))}m`
    : hours < 24
      ? `${Math.floor(hours)}h`
      : new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: displayTimezone });
}
function fullTime(value: string) {
  return formatLocalTime(value, displayTimezone);
}
function RichText({ text, quoteId }: { text: string; quoteId?: string }) {
  return (
    <div className="markdown" data-quote-source={quoteId}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <div className="code-block">
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

type AgentFile = {
  path: string; name: string; label: string; source: 'current' | 'reference' | 'imported';
  generated: boolean; available: boolean; updatedAt?: string; error?: string; markdown?: string;
};
function AgentFiles({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<AgentFile[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [detail, setDetail] = useState<AgentFile | null>(null);
  const [detailError, setDetailError] = useState('');
  const selected = history[history.length - 1];
  const displayed = detail?.path === selected ? detail : null;
  useEffect(() => {
    let current = true;
    setError('');
    void api<{ files: AgentFile[] }>(`/agents/${encodeURIComponent(agentId)}/files`)
      .then(value => { if (current) setFiles(value.files); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [agentId, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    let current = true;
    setDetail(null); setDetailError('');
    if (selected) void api<AgentFile>(`/agents/${encodeURIComponent(agentId)}/files/content?path=${encodeURIComponent(selected)}`)
      .then(value => { if (current) setDetail(value); })
      .catch(e => { if (current) setDetailError(String(e)); });
    return () => { current = false; };
  }, [agentId, selected]);
  const openLink = (href: string): string | null => {
    try {
      const link = new URL(href, `https://agent.invalid/${selected}`);
      if (link.origin !== 'https://agent.invalid' || !link.pathname.endsWith('.md')) return null;
      const file = decodeURIComponent(link.pathname.slice(1));
      return file.startsWith('memory/') || files?.some(item => item.path === file) ? file : null;
    } catch { return null; }
  };
  return <section className="agent-files" aria-labelledby="agent-files-heading">
    <div className="overview-section-heading">
      <h3 id="agent-files-heading">Agent files {files && <span className="skills-count">{files.length}</span>}</h3>
      <button className="text-button" onClick={() => setRevision(value => value + 1)} title="Refresh this agent’s files">Refresh files</button>
    </div>
    {error ? <div className="skills-state" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></div>
      : files === null ? <p className="skills-state" role="status">Loading agent files…</p>
      : !files.length ? <p className="skills-state">No identity or memory files found for this agent.</p>
      : <>
        <div className="agent-file-grid">{files.filter(file => file.source !== 'imported').map(file => <button
          className="agent-file-row" key={file.path} disabled={!file.available}
          aria-label={file.available ? `Read ${file.label}` : `${file.label}: ${file.error}`}
          onClick={() => setHistory([file.path])}
        >
          <Icon name="note" size={18} />
          <span><strong>{file.label}</strong><small>{file.error || file.path}</small></span>
          {file.generated && <span className="skill-source">Generated</span>}
          {file.source === 'reference' && <span className="skill-source">Reference</span>}
          <Icon name="chevron" size={14} />
        </button>)}</div>
        {files.some(file => file.source === 'imported') && <div className="agent-imported-files">
          <h4>Imported references</h4>
          <div>{files.filter(file => file.source === 'imported').map(file => <button
            className="agent-file-chip" key={file.path} disabled={!file.available} title={file.error || file.path}
            aria-label={file.available ? `Read imported ${file.name}` : `${file.name}: ${file.error}`}
            onClick={() => setHistory([file.path])}
          ><Icon name="note" size={14} />{file.name}</button>)}</div>
        </div>}
      </>}
    {selected && <Dialog title={selected.split('/').pop() || 'Agent file'} close={() => setHistory([])} wide>
      <div className="form-body agent-file-detail">
        <div className="agent-file-meta">
          {history.length > 1 && <button className="text-button" onClick={() => setHistory(old => old.slice(0, -1))}>← Back</button>}
          <code>{selected}</code><span className="skill-source">Read-only</span>
        </div>
        {displayed?.generated && <p className="skills-state">Generated at agent startup from standing instructions and tool configuration.</p>}
        {displayed?.source === 'imported' && <p className="skills-state">Imported reference. Current standing instructions are in instructions.prepend.md.</p>}
        {displayed?.updatedAt && <p className="agent-file-updated">Updated {fullTime(displayed.updatedAt)}</p>}
        {detailError ? <p role="alert">{detailError}</p> : !displayed ? <p role="status">Loading file…</p>
          : !displayed.markdown?.trim() ? <p className="skills-state">This file is empty.</p>
          : <div className="markdown agent-file-body"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => {
            const linkedFile = href ? openLink(href) : null;
            if (linkedFile) return <button className="agent-file-link" onClick={() => setHistory(old => [...old, linkedFile])}>{children}</button>;
            if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            return <span title={href}>{children}</span>;
          } }}>{displayed.markdown}</Markdown></div>}
      </div>
    </Dialog>}
  </section>;
}

type AgentSkill = {
  id: string; name: string; description: string; source: 'shared' | 'agent';
  available: boolean; error?: string; markdown?: string;
};
function AgentSkills({ agentId }: { agentId: string }) {
  const [inventory, setInventory] = useState<{ skills: AgentSkill[]; warnings: string[] } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<AgentSkill | null>(null);
  const [detail, setDetail] = useState<AgentSkill | null>(null);
  const [detailError, setDetailError] = useState('');
  useEffect(() => {
    let current = true;
    setError('');
    void api<{ skills: AgentSkill[]; warnings: string[] }>(`/agents/${encodeURIComponent(agentId)}/skills`)
      .then(value => { if (current) setInventory(value); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [agentId, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    let current = true;
    setDetail(null); setDetailError('');
    if (selected) void api<AgentSkill>(`/agents/${encodeURIComponent(agentId)}/skills/${selected.id}`)
      .then(value => { if (current) setDetail(value); })
      .catch(e => { if (current) setDetailError(String(e)); });
    return () => { current = false; };
  }, [agentId, selected]);
  const filtered = inventory?.skills.filter(skill =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ) ?? [];
  return <section className="agent-skills" aria-labelledby="agent-skills-heading">
    <div className="overview-section-heading">
      <h3 id="agent-skills-heading">Skills {inventory && <span className="skills-count">{inventory.skills.length}</span>}</h3>
      <button className="text-button" onClick={() => setRevision(value => value + 1)} title="Refresh this agent’s skills">Refresh</button>
    </div>
    {inventory && inventory.skills.length > 0 && <label className="skills-filter">
      <Icon name="search" size={16} />
      <input aria-label="Filter skills" placeholder="Filter skills…" value={query} onChange={e => setQuery(e.target.value)} />
    </label>}
    {error ? <div className="skills-state" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></div>
      : !inventory ? <p className="skills-state" role="status">Loading skills…</p>
      : !inventory.skills.length ? <p className="skills-state">No skills available for this agent.</p>
      : !filtered.length ? <p className="skills-state" role="status">No skills match your search.</p>
      : <div className="skills-grid">{filtered.map(skill => <button
        key={skill.id} className="skill-row" disabled={!skill.available}
        onClick={() => setSelected(skill)} aria-label={skill.available ? `View ${skill.name} skill` : `${skill.name}: ${skill.error}`}
      >
        <span className="skill-row-main"><strong>{skill.name}</strong><span className="skill-source">{skill.source === 'agent' ? 'Agent-specific' : 'Shared'}</span></span>
        <span className="skill-description">{skill.description || skill.error}</span>
        {!skill.available && skill.description && <span className="skill-description">{skill.error}</span>}
      </button>)}</div>}
    {inventory?.warnings.map(warning => <p key={warning} className="skills-state" role="status">{warning}</p>)}
    {selected && <Dialog title={selected.name} close={() => setSelected(null)} wide>
      <div className="skill-detail form-body">
        <span className="skill-source">{selected.source === 'agent' ? 'Agent-specific' : 'Shared'}</span>
        <p className="skill-detail-description">{detail?.description ?? selected.description}</p>
        {detailError ? <p role="alert">{detailError}</p> : !detail ? <p role="status">Loading instructions…</p>
          : <RichText text={detail.markdown || 'No additional instructions.'} />}
      </div>
    </Dialog>}
  </section>;
}

function ToolInputPreview({ input }: { input: unknown }) {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* Plain commands are already readable. */ }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const args = value as Record<string, unknown>;
    value = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'description']
      .map(key => args[key]).find(item => typeof item === 'string' && item.trim()) ?? value;
  }
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === '{}' || text === 'null') return null;
  return <code className="tool-input-preview" title={text}>{text.length > 300 ? `${text.slice(0, 300)}…` : text}</code>;
}

function ProgressContent({ value, label = 'Output' }: { value: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  let text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // Plain command output remains exactly as received.
    }
  }
  const lines = text.split('\n');
  const large = lines.length > 6 || text.length > 700;
  const preview = lines
    .slice(0, 4)
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line))
    .join('\n');
  return (
    <div className="progress-content">
      <div className="progress-content-label">
        <span>{label}</span>
        <span>
          {lines.length.toLocaleString()} lines · {text.length.toLocaleString()} characters
        </span>
      </div>
      <pre tabIndex={0} aria-label={label}>
        {large && !expanded ? `${preview}\n…` : text}
      </pre>
      {large && (
        <button
          title={expanded ? `Collapse ${label.toLowerCase()} to a preview` : `Read the full ${label.toLowerCase()}`}
          className="progress-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? 'down' : 'chevron'} size={13} />
          {expanded ? `Collapse ${label.toLowerCase()}` : `Show full ${label.toLowerCase()}`}
        </button>
      )}
    </div>
  );
}

type ActivitySummary = { count: number; text: string; state: string; error: string | null };
function ActivityLabel({ label, summary }: {label: string; summary?: ActivitySummary}) {
  return <span className="activity-label"><strong>{label}</strong>
    {summary?.text ? <small>{summary.text}</small> : ['pending','running'].includes(summary?.state ?? '') ? <small>Summarizing activity…</small> : null}
  </span>;
}
function ActivitySummaryAction({sessionId, groupKey, messageIds, summary, notify}: {sessionId: string; groupKey: string; messageIds?: string[]; summary?: ActivitySummary; notify: (s: string) => void}) {
  const [busy,setBusy] = useState(false);
  if (summary?.text || ['pending','running'].includes(summary?.state ?? '')) return null;
  return <div className="activity-summary-action">
    {summary?.error && <span role="status">{summary.error}</span>}
    <button type="button" className="text-button" disabled={busy} onClick={() => {
      setBusy(true);
      void api(`/sessions/${sessionId}/activity-summary`, 'POST', {key: groupKey, messageIds}).catch(e=>notify(String(e))).finally(()=>setBusy(false));
    }}>{busy ? 'Queuing summary…' : summary?.error ? 'Retry summary' : 'Summarize activity'}</button>
  </div>;
}

function SessionFiles({ id, version, notify }: { id: string; version: number; notify: (s: string) => void }) {
  const [files, setFiles] = useState<Message['files']>([]);
  useEffect(() => {
    void api<Message['files']>(`/sessions/${id}/files`)
      .then(setFiles)
      .catch((e) => notify(String(e)));
  }, [id, version]);
  return (
    <>
      <div className="context-session-info">
        <span className="eyebrow">SESSION FILES</span>
        <h3>{files.length ? `${files.length} attachments` : 'No attachments yet'}</h3>
      </div>
      <div className="message-files">
        {files.map((file) => (
          <a className="file-card" key={file.id} href={`/api/files/${file.id}`} download={file.name}>
            {file.mime?.startsWith('image/') && file.mime !== 'image/svg+xml' ? (
              <img src={`/api/files/${file.id}?inline=1`} alt={file.name} loading="lazy" />
            ) : (
              <Icon name="note" size={21} />
            )}
            <span>
              {file.name}
              <small>Download attachment</small>
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

function RequestCard({
  request,
  answer,
}: {
  request: Detail['pending'][number];
  answer: (value: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const reasoning = request.status === 'awaiting_reason';
  const submit = async (value: string) => {
    if (busy || !value.trim()) return;
    setBusy(true);
    try {
      await answer(value.trim());
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="question-card" id={`request-${request.id}`}>
      <div>
        <Icon name={request.type === 'approval' ? 'shield' : 'chat'} size={18} />
        <h3>{request.title}</h3>
      </div>
      {request.question && <RichText text={request.question} />}
      {!reasoning && (
        <div className="question-options">
          {request.options.map((option, index) => (
            <button
              title={`Send this answer: ${typeof option === 'string' ? option : option.label}`}
              className="button secondary small"
              disabled={busy}
              key={index}
              onClick={() => void submit(typeof option === 'string' ? option : (option.value ?? option.label))}
            >
              {typeof option === 'string' ? option : option.label}
            </button>
          ))}
        </div>
      )}
      {(reasoning || request.type === 'question') && (
        <form
          className="free-answer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(text);
          }}
        >
          <input
            aria-label={reasoning ? 'Rejection reason' : 'Your answer'}
            placeholder={reasoning ? 'Why should this be rejected?' : 'Or write your own answer…'}
            maxLength={reasoning ? 280 : 10_000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            title={reasoning ? 'Reject the request with your reason' : 'Send your written answer to the agent'}
            className="button secondary small"
            disabled={busy || !text.trim()}
          >
            {reasoning ? 'Reject with reason' : 'Send answer'}
          </button>
        </form>
      )}
    </div>
  );
}

function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('input,textarea,button,select'))?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]',
          ) ?? []),
        ];
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <IconButton tooltip="Close this dialog" icon="close" label="Close" onClick={close} />
        </div>
        {children}
      </div>
    </div>
  );
}

type FolderAccess = Directory & { allowed: boolean; grantable: boolean; reason: string };
function FolderAccessReview({ directories, runtimeDriver, initialAccess, onGranted }: {
  directories: Directory[];
  runtimeDriver?: string | null;
  initialAccess?: FolderAccess[];
  onGranted?: () => void;
}) {
  const [access, setAccess] = useState<FolderAccess[] | null>(initialAccess ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selection = JSON.stringify(directories);
  useEffect(() => {
    let active = true;
    setAccess(null);
    setError('');
    void api<FolderAccess[]>('/directories/inspect', 'POST', { directories: JSON.parse(selection), runtimeDriver })
      .then(value => { if (active) setAccess(value); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [selection, runtimeDriver]);
  const missing = access?.filter(d => !d.allowed && d.grantable) ?? [];
  const grant = async () => {
    if (!window.confirm(`Allow these folders for sessions you attach them to?\n\n${missing.map(d => `${d.readonly ? 'Read-only' : 'Read and write'}: ${d.path}`).join('\n')}\n\nThis includes files and subfolders. This permission is saved on your workspace host.`)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<FolderAccess[]>('/directories/grant', 'POST', { directories: missing, confirm: true, runtimeDriver });
      setAccess(old => old?.map(d => result.find(next => next.id === d.id) ?? d) ?? result);
      onGranted?.();
    } catch(e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="access-review creation-folder-access" aria-label="Folder access" aria-busy={busy}>
    <h3>Folder access</h3>
    {!access && !error && <p className="form-help" role="status">Checking folder access…</p>}
    {access?.map(d => <div key={d.id} className={d.allowed ? 'good' : 'warning'}>
      <Icon name={d.allowed ? 'check' : 'shield'} size={15} />
      <span><DirectoryPath path={d.path} /><small>{d.readonly ? 'Read-only' : 'Read and write'} · {d.allowed ? 'Allowed' : d.grantable ? 'Permission needed' : d.reason}</small></span>
    </div>)}
    {missing.length > 0 && <button className="button secondary" disabled={busy} onClick={() => void grant()}>{busy ? 'Allowing…' : 'Allow folder access'}</button>}
    {access?.length && access.every(d => d.allowed) ? <p className="form-help" role="status">Folder access is ready. You can start the conversation.</p> : null}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

function DirectoryEditor({
  value,
  change,
  primary,
  setPrimary,
  notify,
  runtimeDriver,
}: {
  runtimeDriver?: string | null;
  value: Directory[];
  change: (v: Directory[]) => void;
  primary?: string | null;
  setPrimary?: (id: string | null) => void;
  notify: (s: string) => void;
}) {
  const [browser, setBrowser] = useState<{
    path: string;
    parent: string;
    entries: { name: string; path: string }[];
  } | null>(null);
  const [typed, setTyped] = useState('');
  const [access, setAccess] = useState<any[] | null>(null);
  const browse = async (directory?: string) => {
    try {
      const data = await api('/directories' + (directory ? `?path=${encodeURIComponent(directory)}` : ''));
      setBrowser(data);
      setTyped(data.path);
    } catch (e) {
      notify(String(e));
    }
  };
  const add = (directory: string) => {
    if (value.some((d) => d.path === directory)) return;
    const next = [...value, { id: crypto.randomUUID(), path: directory, readonly: false }];
    change(next);
    if (!primary && setPrimary) setPrimary(next[0].id);
    setBrowser(null);
    setAccess(null);
  };
  return (
    <div className="directory-editor">
      {value.map((directory) => (
        <div className="directory-row" key={directory.id}>
          <Icon name="folder" />
          <div className="directory-name">
            <strong title={directory.path}>{directory.path.split('/').pop()}</strong>
            <span title={directory.path}><DirectoryPath path={directory.path} /></span>
          </div>
          {setPrimary && (
            <button
              className={`tag-button ${primary === directory.id ? 'selected' : ''}`}
              title={
                primary === directory.id
                  ? 'Current default working directory'
                  : 'Use this folder as the working directory'
              }
              onClick={() => setPrimary(directory.id)}
            >
              {primary === directory.id ? 'Working' : 'Set working'}
            </button>
          )}
          <button
            className="access-toggle"
            onClick={() => {
              change(value.map((d) => (d.id === directory.id ? { ...d, readonly: !d.readonly } : d)));
              setAccess(null);
            }}
            title={directory.readonly ? 'Switch this folder to read and write' : 'Switch this folder to read-only'}
          >
            {directory.readonly ? 'Read' : 'Write'}
          </button>
          <IconButton
            tooltip={`Detach ${directory.path} without deleting its files`}
            icon="close"
            label={`Remove ${directory.path}`}
            onClick={() => {
              const next = value.filter((d) => d.id !== directory.id);
              change(next);
              if (primary === directory.id) setPrimary?.(next[0]?.id ?? null);
              setAccess(null);
            }}
          />
        </div>
      ))}
      <div className="directory-actions">
        <button title="Choose a folder to attach" className="button secondary small" onClick={() => void browse()}>
          <Icon name="plus" size={15} />
          Add folder
        </button>
        {value.length > 0 && (
          <button
            title="Check access to the selected folders"
            className="text-button"
            onClick={() =>
              void api<any[]>('/directories/inspect', 'POST', { directories: value, runtimeDriver })
                .then(setAccess)
                .catch((e) => notify(String(e)))
            }
          >
            Review access
          </button>
        )}
      </div>
      {access && <FolderAccessReview directories={value} runtimeDriver={runtimeDriver} initialAccess={access} />}
      {browser && (
        <div className="folder-browser">
          <div className="browser-path">
            <input
              aria-label="Folder path"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void browse(typed);
                }
              }}
            />
            <button
              title="Browse the entered folder path"
              className="button secondary small"
              onClick={() => void browse(typed)}
            >
              Go
            </button>
          </div>
          <button
            title="Browse the parent folder"
            className="folder-choice parent"
            onClick={() => void browse(browser.parent)}
          >
            <Icon name="arrow" size={15} />
            Parent folder
          </button>
          <div className="folder-list">
            {browser.entries.map((d) => (
              <button
                title={`Browse ${d.path}`}
                className="folder-choice"
                key={d.path}
                onClick={() => void browse(d.path)}
              >
                <Icon name="folder" size={16} />
                <span>{d.name}</span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
            {!browser.entries.length && <div className="muted empty-small">No subfolders</div>}
          </div>
          <div className="browser-footer">
            <button title="Close the folder picker" className="text-button" onClick={() => setBrowser(null)}>
              Cancel
            </button>
            <button
              title="Attach this folder to the selection"
              className="button primary small"
              onClick={() => add(browser.path)}
            >
              Attach this folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectForm({
  project,
  close,
  saved,
  notify,
}: {
  project?: Project;
  close: () => void;
  saved: (project: Project) => void;
  notify: (s: string) => void;
}) {
  const projectNotifications = useNotifications(!!project);
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [directories, setDirectories] = useState(project?.directories ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const data = await api<Project>(project ? `/projects/${project.id}` : '/projects', project ? 'PATCH' : 'POST', {
        name,
        description,
        directories,
      });
      saved(data);
      close();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={project ? 'Project settings' : 'New project'} close={close}>
      <div className="form-body" role="region" aria-label="Form fields" tabIndex={0}>
      {project && (
        <ScopeNotifications
          target={{ scope: 'project', id: project.id, name: project.name }}
          settings={projectNotifications.settings}
        />
      )}
        <label>
          Project name
          <input
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What are you working on?"
            maxLength={150}
          />
        </label>
        <label>
          Project brief
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Goals, useful background, and how the agent should approach this project."
            rows={5}
          />
        </label>
        <div className="field-heading">
          <span>Default folders</span>
          <span className="muted">For new sessions</span>
        </div>
        <DirectoryEditor value={directories} change={setDirectories} notify={notify} />
      </div>
      <div className="modal-footer">
        <button title="Discard project changes" className="button secondary" onClick={close}>
          Cancel
        </button>
        <button
          title={
            project
              ? 'Save the project brief and default folders'
              : 'Create this project with its brief and default folders'
          }
          className="button primary"
          disabled={!name.trim() || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : project ? 'Save project' : 'Create project'}
        </button>
      </div>
    </Dialog>
  );
}

function LatestMessagePreview({ session, agents }: { session: Session; agents: Agent[] }) {
  const message = session.latestMessage;
  const sender = message?.sender ?? (message?.role === 'assistant' ? agents.find(agent => agent.id === session.agentId)?.name ?? 'Agent' : 'You');
  return <span className={`latest-message-preview ${message ? '' : 'empty'}`} title={message ? `${sender}: ${message.text}` : undefined}>
    {message ? <><span className="preview-sender">{sender}:</span> {message.text}</> : 'No messages yet'}
  </span>;
}

function UnreadBadge({ count, verbose = false }: { count: number; verbose?: boolean }) {
  if (!(count > 0)) return null;
  return <span className="session-unread-badge" aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`} title={`${count} unread ${count === 1 ? 'message' : 'messages'}`}>
    {count > 99 ? '99+' : count}{verbose ? ' new' : ''}
  </span>;
}

function Scratchpad({
  bounded = false,
  scope,
  id,
  notify,
  jobs,
  onSaved,
  version,
}: {
  version?: number;
  scope: 'session' | 'project';
  bounded?: boolean;
  id: string;
  notify: (s: string) => void;
  jobs: Bootstrap['jobs'];
  onSaved?: () => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [fullPreview, setFullPreview] = useState(false);
  const [history, setHistory] = useState<Doc[] | null>(null);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Doc | null>(null);
  const load = useCallback(async () => {
    const value = await api<Doc>(`/documents/${scope}/${id}`);
    setDoc(value);
    if (!editing) setDraft(value.markdown);
  }, [scope, id, editing]);
  useEffect(() => {
    setEditing(false);
    setDoc(null);
    setFullPreview(false);
    void api<Doc>(`/documents/${scope}/${id}`)
      .then((value) => {
        setDoc(value);
        setDraft(value.markdown);
      })
      .catch((e) => notify(String(e)));
  }, [scope, id]);
  useEffect(() => {
    if (!editing) void load().catch((e) => notify(String(e)));
  }, [jobs.map((j) => `${j.task}:${j.state}`).join('|'), version]);
  const save = async (text = draft, revision = doc?.revision) => {
    if (!doc) return;
    setSaving(true);
    try {
      const next = await api<Doc>(`/documents/${scope}/${id}`, 'PUT', { markdown: text, revision });
      setConflict(null);
      setDoc(next);
      setDraft(next.markdown);
      setEditing(false);
      setHistory(null);
      onSaved?.();
    } catch (e) {
      notify(`${String(e)} Your draft has been kept.`);
      const latest = await api<Doc>(`/documents/${scope}/${id}`);
      if (latest.revision !== doc.revision) setConflict(latest);
    } finally {
      setSaving(false);
    }
  };
  const job = jobs.find((j) => j.scope_id === id && j.task === `${scope}-summary`);
  return (
    <div className="scratchpad">
      <div className="section-toolbar">
        <div className="eyebrow">{scope === 'project' ? 'Shared scratchpad' : 'Scratchpad'}</div>
        <div className="row">
          <IconButton
            tooltip="View saved scratchpad revisions"
            icon="clock"
            label="Revision history"
            onClick={() =>
              void api<Doc[]>(`/documents/${scope}/${id}/revisions`)
                .then(setHistory)
                .catch((e) => notify(String(e)))
            }
          />
          <IconButton
            tooltip="Ask the utility model to update these notes"
            icon="spark"
            label="Update overview"
            onClick={() =>
              void api('/utilities/refresh', 'POST', { id, task: `${scope}-summary` })
                .then(() => notify('Overview update queued.'))
                .catch((e) => notify(String(e)))
            }
          />
          <IconButton
            tooltip={editing ? 'Preview your scratchpad draft' : 'Edit scratchpad notes'}
            icon="edit"
            label={editing ? 'Preview notes' : 'Edit scratchpad'}
            active={editing}
            onClick={() => setEditing(!editing)}
          />
        </div>
      </div>
      {!doc ? (
        <div className="loading-lines">
          <i />
          <i />
          <i />
        </div>
      ) : editing ? (
        <>
          <textarea
            className="scratchpad-editor"
            aria-label="Scratchpad Markdown"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Your working notes…"
          />
          <div className="edit-actions">
            <button
              title="Discard unsaved note changes"
              className="text-button"
              onClick={() => {
                setEditing(false);
                setDraft(doc.markdown);
              }}
            >
              Cancel
            </button>
            <button
              title="Save these scratchpad notes"
              className="button primary small"
              disabled={saving}
              onClick={() => void save()}
            >
              Save notes
            </button>
          </div>
        </>
      ) : doc.markdown ? (
        bounded ? (
          <>
            <div className="scratchpad-bounded-preview" role="region" aria-label="Project scratchpad preview" tabIndex={0}>
              <RichText text={doc.markdown} />
            </div>
            <button type="button" className="text-button scratchpad-open-full" onClick={() => setFullPreview(true)}>
              Open full scratchpad
            </button>
          </>
        ) : <RichText text={doc.markdown} />
      ) : (
        <div className="scratch-empty">
          <span className="note-illustration">
            <Icon name="note" size={24} />
          </span>
          <h3>A place to keep the thread.</h3>
          <p>Decisions, progress, and what comes next.</p>
          <button
            title="Start writing scratchpad notes"
            className="button secondary small"
            onClick={() => {
              setEditing(true);
              setDraft('');
            }}
          >
            <Icon name="plus" size={15} />
            Add a note
          </button>
        </div>
      )}
      {conflict && (
        <div className="access-review warning">
          <strong>These notes changed while you were editing.</strong>
          <details>
            <summary title="Show the latest saved notes">Read the latest revision</summary>
            <RichText text={conflict.markdown} />
          </details>
          <div className="row">
            <button
              title="Replace your draft with the latest notes"
              className="button secondary small"
              onClick={() => {
                setDoc(conflict);
                setDraft(conflict.markdown);
                setConflict(null);
                setEditing(false);
              }}
            >
              Use latest
            </button>
            <button
              title="Save your draft over the latest notes"
              className="button primary small"
              disabled={saving}
              onClick={() => void save(draft, conflict.revision)}
            >
              Save my draft as a new revision
            </button>
          </div>
        </div>
      )}
      {doc && doc.revision > 0 && (
        <div className="doc-stamp" title={fullTime(doc.updatedAt)}>
          Revision {doc.revision}
          <span>·</span>
          {doc.author.startsWith('human:')
            ? 'Edited by you'
            : doc.author.startsWith('agent:')
              ? 'Updated by agent'
              : 'Updated automatically'}
          <span>·</span>
          {ago(doc.updatedAt)}
        </div>
      )}
      {job && (
        <div className={`job-status ${job.state === 'failed' ? 'warning' : ''}`}>
          <Icon name={job.state === 'failed' ? 'shield' : 'spark'} size={14} />
          {job.state === 'failed'
            ? job.error
            : job.state === 'running'
              ? 'Updating overview…'
              : job.error
                ? `Retry scheduled · ${job.error}`
                : 'Overview update queued'}
        </div>
      )}
      {fullPreview && doc && (
        <Dialog title="Project scratchpad" wide close={() => setFullPreview(false)}>
          <div className="form-body scratchpad-full-preview" role="region" aria-label="Full project scratchpad" tabIndex={0}>
            <RichText text={doc.markdown} />
          </div>
        </Dialog>
      )}
      {history && (
        <Dialog
          title="Scratchpad history"
          wide
          close={() => {
            setHistory(null);
            setSelected(null);
          }}
        >
          <div className="history-layout">
            <div className="revision-list">
              {history.map((revision) => (
                <button
                  title={`Read scratchpad revision ${revision.revision}`}
                  key={revision.revision}
                  className={selected?.revision === revision.revision ? 'selected' : ''}
                  onClick={() => setSelected(revision)}
                >
                  <strong>Revision {revision.revision}</strong>
                  <span>{fullTime(revision.updatedAt)}</span>
                  <small>{revision.author.split(':')[0]}</small>
                </button>
              ))}
              {!history.length && <p className="muted">No saved revisions yet.</p>}
            </div>
            <div className="revision-preview">
              {selected ? (
                <>
                  <RichText text={selected.markdown} />
                  <details>
                    <summary title="View this revision beside the current notes">Compare with current notes</summary>
                    <div className="revision-diff">
                      <pre>{selected.markdown}</pre>
                      <pre>{doc?.markdown}</pre>
                    </div>
                  </details>
                  <button
                    title="Save this older revision as the current notes"
                    className="button secondary"
                    disabled={saving || selected.revision === doc?.revision}
                    onClick={() => void save(selected.markdown)}
                  >
                    Restore this revision
                  </button>
                </>
              ) : (
                <div className="muted">Select a revision</div>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ProfileEditor({
  value,
  change,
  agents,
  notify,
}: {
  value: Profile;
  change: (v: Profile) => void;
  agents: Agent[];
  notify: (s: string) => void;
}) {
  const [status, setStatus] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    setStatus(null);
  }, [JSON.stringify(value)]);
  const check = async (test = false) => {
    setChecking(true);
    try {
      const result = await api(test ? '/utilities/test' : '/utilities/status', 'POST', {
        profile: !test && value.provider === 'ollama' && !value.model ? { ...value, model: '__discovery_only__' } : value,
        agentId: agents[0]?.id,
      });
      setStatus(result);
      if (result.models)
        setModels(
          result.models
            .filter((m: any) => !m.capabilities?.includes('embedding') || m.capabilities?.includes('completion'))
            .map((m: any) => m.name),
        );
    } catch (e) {
      setStatus({ error: String(e) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="profile-editor">
      <div className="provider-choices">
        {(
          [
            ['ollama', 'Ollama', 'terminal'],
            ['apple', 'Apple on-device', 'spark'],
            ['agent', 'Agent model', 'chat'],
          ] as const
        ).map(([provider, label, icon]) => (
          <button
            title={`Use ${label} for utility tasks`}
            className={value.provider === provider ? 'selected' : ''}
            key={provider}
            onClick={() =>
              change(
                provider === 'ollama'
                  ? { provider, endpoint: 'http://127.0.0.1:11434', model: '' }
                  : { provider },
              )
            }
          >
            <Icon name={icon} size={18} />
            <span>{label}</span>
            {value.provider === provider && <Icon name="check" size={15} />}
          </button>
        ))}
      </div>
      {value.provider === 'ollama' && (
        <div className="profile-fields">
          <label>
            Endpoint
            <input value={value.endpoint ?? ''} onChange={(e) => change({ ...value, endpoint: e.target.value })} />
          </label>
          <label>
            Model
            <input
              list="installed-models"
              placeholder="Installed model name"
              value={value.model ?? ''}
              onChange={(e) => change({ ...value, model: e.target.value })}
            />
            <datalist id="installed-models">
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </datalist>
          </label>
        </div>
      )}
      {value.provider === 'agent' && (
        <label>
          Agent
          <select
            value={value.agentId ?? ''}
            onChange={(e) => change({ ...value, agentId: e.target.value || undefined })}
          >
            <option value="">Follow the session’s agent</option>
            {agents.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="profile-actions">
        <span className="local-badge">
          <Icon name={value.provider === 'agent' ? 'shield' : 'terminal'} size={13} />
          {value.provider === 'agent' ? 'Existing agent provider' : 'On this host'}
        </span>
        <button
          title="Check whether the utility model is available"
          className="text-button"
          disabled={checking}
          onClick={() => void check(false)}
        >
          Check connection
        </button>
        <button
          title="Generate a sample title with this model"
          className="button secondary small"
          disabled={checking}
          onClick={() => void check(true)}
        >
          {checking ? 'Checking…' : 'Test model'}
        </button>
      </div>
      {status && (
        <div className={`model-result ${status.error || status.available === false ? 'warning' : 'good'}`}>
          <Icon name={status.error || status.available === false ? 'shield' : 'check'} size={16} />
          <span>
            {status.error ??
              (status.text
                ? `Generated title: ${status.text}`
                : status.available
                  ? `Ready${status.contextSize ? ` · ${status.contextSize.toLocaleString()} tokens` : ''}`
                  : 'Selected model is not installed.')}
          </span>
        </div>
      )}
    </div>
  );
}

function NetworkSettings({ notify }: { notify: (s: string) => void }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    available: boolean;
    running: boolean;
    url: string | null;
    error: string | null;
    preview: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; code?: string; expires: number; codeExpires: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void api('/network')
      .then(setStatus)
      .catch((e) => notify(String(e)));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const statusTimer = setInterval(() => {
      void api('/network')
        .then(setStatus)
        .catch((e) => notify(String(e)));
    }, 15000);
    return () => {
      clearInterval(timer);
      clearInterval(statusTimer);
    };
  }, []);
  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    setLink(null);
    try {
      setStatus(await api('/network', 'PATCH', { enabled: !status.enabled }));
    } catch (e) {
      notify(String(e));
      try {
        setStatus(await api('/network'));
      } catch {
        setStatus((current) =>
          current ? { ...current, error: 'Connection interrupted. Check workspace access on your workspace host.' } : current,
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const pair = async () => {
    setBusy(true);
    try {
      const result = await api('/network/pair', 'POST', {});
      setLink({
        url: result.url,
        code: result.code,
        expires: Date.now() + result.expiresInSeconds * 1000,
        codeExpires: Date.now() + result.codeExpiresInSeconds * 1000,
      });
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <InstallApp />
      <DeviceAccess />
      <div className="settings-section-heading">
        <div>
          <h3>Your workspace, on your devices.</h3>
          <p>Use your iPhone or another device connected to your tailnet.</p>
        </div>
      </div>
      <div className="setting-line">
        <div>
          <strong>Tailscale access</strong>
          <span>Private HTTPS access. Localhost stays available.</span>
        </div>
        <button
          title={
            status?.preview
              ? 'Tailscale access is unavailable in preview'
              : status?.enabled
                ? 'Turn off workspace access through Tailscale'
                : 'Allow private workspace access through Tailscale'
          }
          role="switch"
          aria-label="Enable Tailscale access"
          aria-checked={status?.enabled ?? false}
          className={`switch ${status?.enabled ? 'on' : ''}`}
          disabled={!status || busy || status.preview}
          onClick={() => void toggle()}
        >
          <i />
        </button>
      </div>
      <div aria-live="polite" className="network-status">
        {busy
          ? 'Updating access…'
          : !status
            ? 'Checking Tailscale…'
            : status.running
              ? 'Available on your tailnet'
              : status.preview
                ? 'Unavailable in the isolated preview'
                : 'Localhost only'}
      </div>
      {status?.error && <p className="warning network-error">{status.error}</p>}
      {status?.running && status.url && (
        <>
          <label>
            Tailnet address
            <a className="network-address" href={status.url} target="_blank" rel="noreferrer">
              {status.url}
              <Icon name="arrow" size={16} />
            </a>
          </label>
          <div className="network-pair">
            <h4>Pair your iPhone</h4>
            <p>
              Connect your iPhone to Tailscale, then open a device pairing link in Safari. Each link works once and
              expires after two minutes. Manually entered codes last 10 minutes.
            </p>
            <button
              title="Create a one-time link to pair another device"
              className="button secondary"
              disabled={busy}
              onClick={() => void pair()}
            >
              <Icon name="plus" size={16} />
              {link ? 'Create a new device link' : 'Create device link'}
            </button>
            {link?.code && now < link.codeExpires && (
              <div className="notification-pair-code">
                <span>Pairing code</span>
                <strong>{link.code}</strong>
                <small>
                  Enter this code in the installed app. Expires in {Math.ceil((link.codeExpires - now) / 60000)}{' '}
                  minutes.
                </small>
              </div>
            )}
            {link && (
              <div className="device-link">
                <label>
                  Device pairing link
                  <input
                    aria-label="Device pairing link"
                    value={link.url}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                </label>
                <button
                  title="Copy the device pairing link"
                  className="button primary"
                  disabled={now >= link.expires}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(link.url)
                      .then(() => notify('Device link copied. Open it on your iPhone.'))
                      .catch((e) => notify(String(e)))
                  }
                >
                  Copy link
                </button>
                <small role="status">
                  {now >= link.expires
                    ? 'This link expired. Create a new one.'
                    : `Expires in ${Math.ceil((link.expires - now) / 1000)} seconds`}
                </small>
              </div>
            )}
          </div>
        </>
      )}
      <div className="context-note">
        <Icon name="shield" size={16} />
        <span>
          Each browser must be paired with your owner account. Switching access off disconnects remote browsers.
        </span>
      </div>
    </>
  );
}

const workspaceSettingsCategories = [
  ['agents', 'chat', 'Agents'],
  ['connections', 'globe', 'API connections'],
  ['models', 'spark', 'Utility models'],
  ['speech', 'chat', 'Speech'],
  ['appearance', 'sun', 'Appearance'],
  ['network', 'globe', 'Access'],
  ['notifications', 'bell', 'Notifications'],
  ['imports', 'archive', 'Import history'],
];

function WorkspaceSettings({
  initialTab = 'agents',
  data,
  close,
  refresh,
  notify,
  previewAppearance,
  appearanceSaved,
  appearanceMode,
}: {
  previewAppearance: (value: WorkspaceAppearance | null) => void;
  appearanceSaved: (value: Settings) => void;
  appearanceMode: 'light' | 'dark';
  initialTab?: string;
  data: Bootstrap;
  close: () => void;
  refresh: () => void;
  notify: (s: string) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [settings, setSettings] = useState<Settings>(structuredClone(data.settings));
  React.useLayoutEffect(() => {
    previewAppearance(settings);
  }, [settings.theme, settings.themePreset, settings.ambientMotion, settings.textScale, previewAppearance]);
  React.useLayoutEffect(() => () => previewAppearance(null), [previewAppearance]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [root, setRoot] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<any>(null);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api<Settings>('/settings', 'PATCH', settings);
      appearanceSaved(saved);
      refresh();
      notify('Workspace settings saved.');
      close();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const inspectImport = async () => {
    setBusy(true);
    try {
      const value = await api(`/import/preview${root ? `?root=${encodeURIComponent(root)}` : ''}`);
      setPreview(value);
      setRoot(value.root);
      const matched = matchImportAgents(value.agents, data.agents);
      setMapping(matched);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (tab !== 'imports') return;
    void api('/import/progress').then(setProgress);
    const timer = setInterval(
      () =>
        void api('/import/progress')
          .then(setProgress)
          .catch(() => {}),
      1500,
    );
    return () => clearInterval(timer);
  }, [tab]);
  return (
    <Dialog title="Workspace settings" close={close} wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Workspace settings categories">
          <select
            className="settings-category-select"
            aria-label="Settings category"
            value={tab}
            onChange={(e) => setTab(e.target.value)}
          >
            {workspaceSettingsCategories.map(([id, , title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
          {workspaceSettingsCategories.map(([id, icon, title]) => (
            <button
              title={`Open ${title.toLowerCase()} settings`}
              key={id}
              className={tab === id ? 'selected' : ''}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} />
              {title}
            </button>
          ))}

        </nav>
        <div className="settings-content" role="region" aria-label="Settings content" tabIndex={0}>
          {tab === 'agents' && <React.Suspense fallback={<p role="status">Loading agent settings…</p>}><AgentModelSettings agents={data.agents} request={api} onSaved={refresh} /></React.Suspense>}
          {tab === 'connections' && <React.Suspense fallback={<p role="status">Loading API connections…</p>}><ApiConnectionSettings agents={data.agents} request={api} onSaved={refresh} /></React.Suspense>}
          {tab === 'speech' && <SpeechSettings value={settings.speech} change={speech=>setSettings({...settings,speech})} request={api} />}
          {tab === 'network' && <NetworkSettings notify={notify} />}
          {tab === 'notifications' && <NotificationSettings data={data} />}
          {tab === 'models' && (
            <>
              <div className="settings-section-heading">
                <div>
                  <h3>Utility models</h3>
                  <p>For overviews, session titles, and working notes.</p>
                </div>
                <span className="tag">Independent of chat</span>
              </div>
              <h4>Default model</h4>
              <ProfileEditor
                value={settings.utility}
                change={(utility) => setSettings({ ...settings, utility })}
                agents={data.agents}
                notify={notify}
              />
              <div className="setting-line">
                <div>
                  <strong>Automatic summaries</strong>
                  <span>Update scratchpads and tool activity labels after completed turns.</span>
                </div>
                <button
                  title={
                    settings.automaticSummaries
                      ? 'Turn off automatic scratchpad and activity summaries'
                      : 'Generate scratchpad and activity summaries automatically'
                  }
                  className={`switch ${settings.automaticSummaries ? 'on' : ''}`}
                  role="switch"
                  aria-label="Update scratchpads automatically"
                  aria-checked={settings.automaticSummaries}
                  onClick={() => setSettings({ ...settings, automaticSummaries: !settings.automaticSummaries })}
                >
                  <i />
                </button>
              </div>
              <label className="maintenance-agent">
                Project maintenance agent
                <select
                  value={settings.maintenanceAgentId ?? ''}
                  onChange={(e) => setSettings({ ...settings, maintenanceAgentId: e.target.value || null })}
                >
                  <option value="">Follow project activity</option>
                  {data.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <h4>Task overrides</h4>
              <div className="task-overrides">
                {[
                  ['title', 'Session titles'],
                  ['session-summary', 'Session scratchpads'],
                  ['project-summary', 'Project scratchpads'],
                  ['activity-summary', 'Tool activity summaries'],
                ].map(([id, title]) => (
                  <div className="task-override" key={id}>
                    <button
                      title={`${expanded === id ? 'Hide' : 'Configure'} the model for ${title.toLowerCase()}`}
                      onClick={() => setExpanded(expanded === id ? null : id)}
                    >
                      <span>{title}</span>
                      <small>{settings.overrides[id]?.provider ?? 'Default model'}</small>
                      <Icon name="down" size={15} />
                    </button>
                    {expanded === id && (
                      <div className="override-form">
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={!settings.overrides[id]}
                            onChange={(e) => {
                              const overrides = { ...settings.overrides };
                              if (e.target.checked) delete overrides[id];
                              else overrides[id] = structuredClone(settings.utility);
                              setSettings({ ...settings, overrides });
                            }}
                          />
                          Use default model
                        </label>
                        {settings.overrides[id] && (
                          <ProfileEditor
                            value={settings.overrides[id]}
                            change={(value) =>
                              setSettings({ ...settings, overrides: { ...settings.overrides, [id]: value } })
                            }
                            agents={data.agents}
                            notify={notify}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'appearance' && (
            <>
              <div className="settings-section-heading">
                <div>
                  <h3>Make yourself at home.</h3>
                  <p>Choose the workspace’s appearance.</p>
                </div>
              </div>
              <PresetChoices value={settings.themePreset} mode={appearanceMode}
                change={themePreset => setSettings({ ...settings, themePreset })} />
              <fieldset className="appearance-mode">
                <legend>Appearance</legend>
                <div className="mode-options">
                  {(['light', 'dark', 'system'] as const).map(theme => <label key={theme}>
                    <input type="radio" name="workspace-mode" value={theme} checked={settings.theme === theme}
                      onChange={() => setSettings({ ...settings, theme })} />
                    <span><Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'globe'} size={17} />
                      {theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System'}</span>
                  </label>)}
                </div>
              </fieldset>
              <label className="ambient-motion-setting">
                <span><strong>Animate background</strong><small>Gentle movement. Follows your device’s reduced motion preference.</small></span>
                <input type="checkbox" role="switch" checked={settings.ambientMotion}
                  disabled={settings.themePreset === 'classic'}
                  onChange={e => setSettings({ ...settings, ambientMotion: e.target.checked })} />
              </label>
              <div className="text-size-setting">
                <label htmlFor="workspace-text-size">
                  Text size
                  <output htmlFor="workspace-text-size">
                    {settings.textScale ?? 100}%{(settings.textScale ?? 100) === 100 ? ' · Default' : ''}
                  </output>
                </label>
                <input
                  id="workspace-text-size"
                  type="range"
                  min="100"
                  max="200"
                  step="10"
                  value={settings.textScale ?? 100}
                  onChange={(e) => setSettings({ ...settings, textScale: Number(e.target.value) })}
                />
                <div className="text-size-labels">
                  <span>Standard</span>
                  <button
                    title="Reset text size to 100%"
                    className="text-button"
                    onClick={() => setSettings({ ...settings, textScale: 100 })}
                  >
                    Reset
                  </button>
                  <span>Largest</span>
                </div>
                <div className="type-sample">
                  <strong>Everything, a little easier to read.</strong>
                  <p>Messages, navigation, and notes scale together.</p>
                  <small>Secondary text stays clear and readable.</small>
                </div>
              </div>
              <div className="setting-line">
                <div>
                  <strong>Live workspace address</strong>
                  <span>localhost:{settings.port}</span>
                </div>
                <span className="tag">Local access</span>
              </div>
            </>
          )}
          {tab === 'imports' && (
            <>
              <div className="settings-section-heading">
                <div>
                  <h3>Bring your history along.</h3>
                  <p>Copy projects and conversations from OpenClaw.</p>
                </div>
              </div>
              <label>
                OpenClaw directory
                <div className="input-action">
                  <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="~/.openclaw" />
                  <button
                    title="Preview history before importing"
                    className="button secondary"
                    onClick={() => void inspectImport()}
                    disabled={busy}
                  >
                    Preview import
                  </button>
                </div>
              </label>
              {preview && (
                <>
                  <h4>Agents</h4>
                  <div className="import-agents">
                    {preview.agents.map((source: any) => (
                      <label key={source.id}>
                        <span>
                          <strong>{source.id}</strong>
                          <small>
                            {source.sessions} sessions · {source.events.toLocaleString()} events
                          </small>
                        </span>
                        <select
                          aria-label={`Import ${source.id} into`}
                          value={mapping[source.id] ?? ''}
                          onChange={(e) => setMapping({ ...mapping, [source.id]: e.target.value })}
                        >
                          <option value="">Do not import</option>
                          {data.agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <h4>{preview.groups.length} shared projects</h4>
                  <div className="import-projects">
                    {preview.groups.map((p: any) => (
                      <div key={p.name}>
                        <Icon name="folder" size={16} />
                        <span>
                          {p.name}
                          <small>{p.cwd || 'No default folder'}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="import-footer">
                    <span className="muted">OpenClaw stays unchanged.</span>
                    <button
                      title="Copy the selected OpenClaw history into NanoClaw"
                      className="button primary"
                      disabled={progress?.state === 'running' || !Object.values(mapping).some(Boolean)}
                      onClick={async () => {
                        try {
                          setProgress(
                            await api('/import/start', 'POST', {
                              root,
                              selections: Object.entries(mapping)
                                .filter(([, id]) => id)
                                .map(([sourceAgentId, targetAgentId]) => ({ sourceAgentId, targetAgentId })),
                            }),
                          );
                        } catch (e) {
                          notify(String(e));
                        }
                      }}
                    >
                      Import selected history
                      <Icon name="arrow" size={16} />
                    </button>
                  </div>
                </>
              )}
              {progress && progress.state !== 'idle' && (
                <div className="import-progress">
                  <strong>
                    {progress.state === 'running'
                      ? 'Importing your history…'
                      : progress.state === 'completed'
                        ? 'History imported'
                        : 'Import needs attention'}
                  </strong>
                  <div className="import-counts">
                    <span>
                      <b>{progress.sessions}</b> sessions
                    </span>
                    <span>
                      <b>{progress.messages.toLocaleString()}</b> messages
                    </span>
                    <span>
                      <b>{progress.files}</b> files
                    </span>
                  </div>
                  {progress.error && <p className="warning">{progress.error}</p>}
                  {progress.unavailableFiles > 0 && (
                    <p className="warning">{progress.unavailableFiles} source attachments are unavailable.</p>
                  )}
                  {progress.warnings?.length > 0 && (
                    <details>
                      <summary title="Show import warnings and missing files">
                        {progress.warnings.length} import notices
                      </summary>
                      {progress.warnings.map((w: string) => (
                        <p key={w}>{w}</p>
                      ))}
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="modal-footer">
        <button title="Close without saving model or appearance changes" className="button secondary" onClick={close}>
          Close
        </button>
        {(tab === 'models' || tab === 'appearance' || tab === 'speech') && (
          <button
            title="Save utility model and appearance settings"
            className="button primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [appearancePreview, setAppearancePreview] = useState<WorkspaceAppearance | null>(null);
  const { appearance, mode: appearanceMode } = useWorkspaceAppearance(data?.settings, appearancePreview);
  const notifications = useNotifications(!!data);
  const [notificationTarget, setNotificationTarget] = useState<Target | null>(null);
  const [pendingActivity, setPendingActivity] = useState<string | null>(
    new URLSearchParams(location.search).get('activity'),
  );
  const [activityTarget, setActivityTarget] = useState<Activity | null>(null);
  const jumping = useRef(false);
  const [updateWorker, setUpdateWorker] = useState<ServiceWorkerRegistration | null>(null);
  const [pairing, setPairing] = useState(false);
  const [fatal, setFatal] = useState('');
  const [agentId, setAgentId] = useState(localStorage.getItem('ws.agent') ?? '');
  const [sessionId, setSessionId] = useState<string | null>(localStorage.getItem('ws.session'));
  const [projectId, setProjectId] = useState<string | null>(null);
  const [navigationReady, setNavigationReady] = useState(false);
  const lastNavigation = useRef<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [panel, setPanel] = useState(localStorage.getItem('ws.panel') !== 'closed');
  const [panelTab, setPanelTab] = useState('session');
  const [modal, setModal] = useState<
    'settings' | 'notifications' | 'activity' | 'project' | 'search' | 'rename' | 'session-settings' | 'requests' | null
  >(null);
  const [editProject, setEditProject] = useState<Project | undefined>();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const [online, setOnline] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState('');
  const [agentMenu, setAgentMenu] = useState(false);
  const [showArchive, setShowArchive] = useState(() => localStorage.getItem('ws.show-archive') === 'true');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    JSON.parse(localStorage.getItem('ws.collapsed') ?? '{}'),
  );
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const { files: attachments, add: addFiles, remove: removeAttachment, clear: clearAttachments, reading: readingAttachments } = useChatAttachments(sessionId, message => notify(message));
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileDragDepth = useRef(0);
  const activeSession = useRef(sessionId); activeSession.current = sessionId;
  const [sending, setSending] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [rename, setRename] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const creationPending = useRef(false);
  const [sessionFolders, setSessionFolders] = useState<Directory[]>([]);
  const [sessionPrimary, setSessionPrimary] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [modelValid, setModelValid] = useState(true);
  const [effort, setEffort] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(Number(localStorage.getItem('ws.sidebar-width')) || 278);
  const [contextWidth, setContextWidth] = useState(Number(localStorage.getItem('ws.context-width')) || 354);
  const [allProjectAgents, setAllProjectAgents] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => {
    setMobileNav(false);
  }, [sessionId, projectId, agentId]);
  useEffect(() => {
    if (modal) setMobileNav(false);
  }, [modal]);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusNewSession = useRef<string | null>(null);
  useEffect(() => {
    if (focusNewSession.current && detail?.session.id === focusNewSession.current) {
      composer.current?.focus();
      focusNewSession.current = null;
    }
  }, [detail?.session.id]);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestVersion = useRef(0);
  const nearBottom = useRef(true);
  const selectedRef = useRef<string | null>(sessionId);
  const loadingRefresh = useRef(false);
  const pendingRefresh = useRef(false);
  selectedRef.current = sessionId;
  useReadingPresence(
    !!data &&
      !!detail &&
      detail.session.id === sessionId &&
      !pendingActivity &&
      !modal &&
      !notificationTarget &&
      !mobileNav,
    sessionId,
    () => nearBottom.current,
  );
  useEffect(() => {
    const update = (e: Event) => setUpdateWorker((e as CustomEvent<ServiceWorkerRegistration>).detail);
    window.addEventListener('workspace-update', update);
    return () => window.removeEventListener('workspace-update', update);
  }, []);
  const notify = useCallback((message: string) => {
    setNotice(message.replace(/^Error: /, ''));
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 9000);
  }, []);
  const refresh = useCallback(async () => {
    if (loadingRefresh.current) {
      pendingRefresh.current = true;
      return;
    }
    loadingRefresh.current = true;
    try {
      const value = await api<Bootstrap>('/bootstrap');
      csrf = value.csrf;
      displayTimezone = value.timezone;
      setData(value);
      setFatal('');
      if (selectedRef.current) {
        const id = selectedRef.current;
        const next = await api<Detail>(`/sessions/${id}`);
        if (selectedRef.current === id)
          setDetail((old) =>
            old && old.session.id === id && old.messages.length > next.messages.length
              ? {
                  ...next,
                  activitySummaries: {...old.activitySummaries,...next.activitySummaries},
                  messages: [
                    ...old.messages.filter((m) => !next.messages.some((n) => n.id === m.id)),
                    ...next.messages,
                  ],
                }
              : next,
          );
      }
      setConnectionIssue('');
      setOnline(true);
    } catch (e) {
      if (e instanceof WorkspaceConnectionError) {
        setOnline(false);
        setConnectionIssue(e.message);
      } else notify(String(e));
    } finally {
      loadingRefresh.current = false;
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void refresh();
      }
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try {
        const token = new URLSearchParams(location.hash.slice(1)).get('pair');
        if (token) {
          setPairing(true);
          await api('/pair', 'POST', { token });
          history.replaceState(null, '', location.pathname + location.search);
        }
        const value = await api<Bootstrap>('/bootstrap');
        csrf = value.csrf;
        csrf = (await identifyInstallation()).csrf;
        displayTimezone = value.timezone;
        configureNotificationTimezone(value.timezone);
        setData(value);
        const initial = resolveNavigation(location.href, value, {
          agentId: localStorage.getItem('ws.agent') ?? '',
          sessionId: localStorage.getItem('ws.session'),
          projectId: null,
        });
        setAgentId(initial.agentId);
        setSessionId(initial.sessionId);
        setProjectId(initial.projectId);
        setNavigationReady(true);
      } catch (e) {
        setFatal(String(e).replace(/^Error: /, ''));
      } finally {
        setPairing(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!data || !navigationReady) return;
    const state = { agentId, projectId, sessionId };
    const key = navigationKey(state);
    const next = navigationUrl(location.href, state);
    if (next !== location.href) {
      if (lastNavigation.current === null || lastNavigation.current === key)
        history.replaceState(null, '', next);
      else history.pushState(null, '', next);
    }
    lastNavigation.current = key;
  }, [agentId, projectId, sessionId, navigationReady]);
  useEffect(() => {
    if (!data || !navigationReady) return;
    const restore = () => {
      const state = resolveNavigation(location.href, data);
      lastNavigation.current = navigationKey(state);
      history.replaceState(null, '', navigationUrl(location.href, state));
      setAgentId(state.agentId);
      setProjectId(state.projectId);
      setSessionId(state.sessionId);
      setModal(null);
      setAgentMenu(false);
      setPendingActivity(new URLSearchParams(location.search).get('activity'));
      if (state.sessionId) setCollapsed(old => ({ ...old, [state.projectId ?? 'unassigned']: false }));
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [data, navigationReady]);
  useEffect(() => {
    if (!data) return;
    const events = new EventSource('/api/events');
    events.onopen = () => setOnline(true);
    events.onerror = () => setOnline(false);
    events.addEventListener('change', () => {
      void refresh();
      window.dispatchEvent(new Event('workspace-change'));
    });
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [!!data, refresh]);
  useEffect(() => {
    if (!data || !pendingActivity) return;
    let cancelled = false;
    void api<Activity>(`/notifications/activity/${pendingActivity}`)
      .then((item) => {
        if (!cancelled) setActivityTarget(item);
      })
      .catch((e) => {
        notify(String(e));
        setPendingActivity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingActivity, !!data]);
  useEffect(() => {
    if (
      !pendingActivity ||
      !activityTarget ||
      activityTarget.id !== pendingActivity ||
      !detail ||
      detail.session.id !== activityTarget.session_id ||
      jumping.current
    )
      return;
    const targetId = activityTarget.request_id
      ? `request-${activityTarget.request_id}`
      : activityTarget.message_id
        ? `message-${activityTarget.message_id}`
        : null;
    const element = targetId ? document.getElementById(targetId) : null;
    if (element) {
      nearBottom.current = false;
      element.scrollIntoView({ block: 'center' });
      element.setAttribute('tabindex', '-1');
      element.focus({ preventScroll: true });
      void api('/notifications/read', 'POST', { id: pendingActivity }).catch((e) => notify(String(e)));
      setPendingActivity(null);
      const url = new URL(location.href);
      url.searchParams.delete('activity');
      history.replaceState(null, '', url);
      return;
    }
    if (activityTarget.message_id && !detail.messages.some((m) => m.id === activityTarget.message_id) && detail.next) {
      jumping.current = true;
      nearBottom.current = false;
      void api<Detail>(`/sessions/${detail.session.id}?before=${encodeURIComponent(detail.next)}&limit=250`)
        .then((earlier) => {
          jumping.current = false;
          setDetail((old) =>
            old?.session.id === earlier.session.id
              ? { ...old, next: earlier.next, activitySummaries: {...earlier.activitySummaries,...old.activitySummaries}, messages: [...earlier.messages, ...old.messages] }
              : old,
          );
        })
        .catch((e) => {
          notify(String(e));
          setPendingActivity(null);
        })
        .finally(() => {
          jumping.current = false;
        });
    } else {
      if (activityTarget.request_id) notify('This request has already been resolved.');
      setPendingActivity(null);
      const url = new URL(location.href);
      url.searchParams.delete('activity');
      history.replaceState(null, '', url);
    }
  }, [detail, activityTarget, pendingActivity]);
  useEffect(() => {
    localStorage.setItem('ws.agent', agentId);
  }, [agentId]);
  useEffect(() => {
    if (!data) return;
    const version = ++requestVersion.current;
    if (!sessionId) {
      localStorage.removeItem('ws.session');
      setDetail(null);
      setDraft(localStorage.getItem(`ws.draft:new:${agentId}`) ?? '');
      return;
    }
    localStorage.setItem('ws.session', sessionId);
    setDraft(localStorage.getItem(`ws.draft:${sessionId}`) ?? '');
    clearAttachments();
    nearBottom.current = true;
    setDetail(null);
    void api<Detail>(`/sessions/${sessionId}`)
      .then((value) => {
        if (requestVersion.current === version) {
          setDetail(value);
          setProjectId(value.session.projectId);
        }
      })
      .catch((e) => notify(String(e)));
  }, [sessionId, !!data]);
  useEffect(() => {
    if (scroll.current && nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [detail?.messages.length, detail?.live && JSON.stringify(detail.live.texts)]);
  useEffect(() => {
    document.title = `${detail?.session.title ?? data?.projects.find((p) => p.id === projectId)?.name ?? 'Workspace'} · NanoClaw`;
  }, [detail?.session.title, projectId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!document.querySelector('[role="dialog"]')) setModal('search');
      }
      if (event.key === 'Escape') setAgentMenu(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (modal !== 'search' || !search.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(
      () =>
        void api<any[]>(`/search?q=${encodeURIComponent(search)}`)
          .then(setResults)
          .catch((e) => notify(String(e))),
      250,
    );
    return () => clearTimeout(timer);
  }, [search, modal]);

  const choose = (session: Session) => {
    setAgentId(session.agentId);
    setSessionId(session.id);
    setProjectId(session.projectId);
    setModal(null);
    setCollapsed((old) => ({ ...old, [session.projectId ?? 'unassigned']: false }));
  };
  const create = async (project: string | null, source?: string) => {
    if (creationPending.current) return;
    creationPending.current = true;
    setCreatingSession(true);
    try {
      const next = await api<Session>('/sessions', 'POST', { agentId, projectId: project, continuedFrom: source });
      focusNewSession.current = next.id;
      await refresh();
      choose(next);
    } catch (e) {
      notify(String(e));
    } finally {
      creationPending.current = false;
      setCreatingSession(false);
    }
  };
  const mutateSession = async (input: Partial<Session>, targetId = sessionId) => {
    if (!targetId) return;
    try {
      await api(`/sessions/${targetId}`, 'PATCH', input);
      await refresh();
    } catch (e) {
      notify(String(e));
    }
  };
  const updateDraft = (text: string) => {
    setDraft(text);
    localStorage.setItem(`ws.draft:${sessionId ?? `new:${agentId}`}`, text);
  };
  const quoting = useMessageQuotes(sessionId ?? '', !!sessionId && detail?.session.id === sessionId && detail.session.origin !== 'openclaw' && !sending && !modal, text => {
    const next = appendQuote(draftRef.current, text);
    if (next.length > 100_000) { notify('That quote would make the message too long. Select a shorter passage.'); return false; }
    draftRef.current = next;
    setDraft(next);
    try { localStorage.setItem(`ws.draft:${sessionId}`, next); }
    catch { notify('Quote added, but browser draft storage is full. Keep this conversation open until sending.'); }
    requestAnimationFrame(() => {
      const input = composer.current;
      if (input) { input.focus(); input.setSelectionRange(next.length, next.length); input.scrollTop = input.scrollHeight; }
    });
    return true;
  });
  const send = async () => {
    if (!sessionId || sending || speechBusy || readingAttachments || (!draft.trim() && !attachments.length)) return;
    const submissionSession = sessionId;
    const payloadAttachments = attachments.map(({name,data,mimeType})=>({name,data,mimeType}));
    setSending(true);
    try {
      const hashBytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify({ text: draft, attachments: payloadAttachments })),
      );
      const hash = Array.from(new Uint8Array(hashBytes), (b) => b.toString(16).padStart(2, '0')).join('');
      const key = `ws.submission:${sessionId}`;
      const prior = JSON.parse(localStorage.getItem(key) ?? 'null');
      const id = prior?.hash === hash ? prior.id : crypto.randomUUID();
      localStorage.setItem(key, JSON.stringify({ id, hash }));
      await api(`/sessions/${sessionId}/messages`, 'POST', { id, text: draft, attachments: payloadAttachments });
      localStorage.removeItem(key);
      localStorage.removeItem(`ws.draft:${submissionSession}`);
      if (activeSession.current === submissionSession) {
        updateDraft(''); clearAttachments(); nearBottom.current = true;
      }
      await refresh();
      if (activeSession.current === submissionSession) composer.current?.focus();
    } catch (e) {
      notify(String(e));
    } finally {
      setSending(false);
    }
  };
  const resize = (event: React.PointerEvent, side: 'sidebar' | 'context') => {
    event.preventDefault();
    const initial = event.clientX;
    const width = side === 'sidebar' ? sidebarWidth : contextWidth;
    const move = (e: PointerEvent) => {
      const value = Math.max(
        240,
        Math.min(
          side === 'sidebar' ? 400 : 560,
          width + (side === 'sidebar' ? e.clientX - initial : initial - e.clientX),
        ),
      );
      if (side === 'sidebar') setSidebarWidth(value);
      else setContextWidth(value);
      localStorage.setItem(`ws.${side}-width`, String(value));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  if (!data)
    return (
      <div className="pairing-screen" role="region" aria-label="Device pairing" tabIndex={0}>
        <div className="pairing-card">
          <Mark />
          <span className="eyebrow">NANOCLAW WORKSPACE</span>
          <h1>
            {fatal ? 'Your workspace is private.' : pairing ? 'Connecting your browser…' : 'Opening your workspace…'}
          </h1>
          {fatal && (
            <>
              <p>
                {fatal.includes('fetch')
                  ? 'Cannot reach your workspace host. Connect Tailscale and make sure NanoClaw is running.'
                  : fatal}
              </p>
              <button className="button secondary" onClick={() => location.reload()}>
                Retry connection
              </button>
              <div className="pair-command">
                <code>{location.protocol === 'https:' ? 'ncl workspace open --tailnet' : 'ncl workspace open'}</code>
                <IconButton
                  tooltip="Copy the command that opens a pairing link"
                  icon="copy"
                  label="Copy pairing command"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      location.protocol === 'https:' ? 'ncl workspace open --tailnet' : 'ncl workspace open',
                    )
                  }
                />
              </div>
              <PairingCode paired={() => location.reload()} />
            </>
          )}
        </div>
      </div>
    );
  const agent = data.agents.find((a) => a.id === agentId) ?? data.agents[0];
  const current = detail?.session;
  const canAttachFiles = !!sessionId && current?.id === sessionId && !!current.nativeSessionId && !modal && !notificationTarget && !sending;
  const project = data.projects.find((p) => p.id === (current?.projectId ?? projectId));
  const agentSessions = data.sessions.filter((s) => s.agentId === agent?.id && (showArchive || !s.archived));
  const pinned = agentSessions.filter((s) => s.pinned);
  const unreadCount = (id: string) => notifications.feed.unreadBySession?.[id] ?? 0;
  const openProjectForm = (p?: Project) => {
    setEditProject(p);
    setModal('project');
  };
  const sessionRow = (s: Session) => (
    <div className="sidebar-session" key={s.id}>
    <button
      className={`session-row ${sessionId === s.id ? 'selected' : ''} ${unreadCount(s.id) ? 'unread' : ''}`}
      title={`Open ${s.archived ? 'archived chat' : 'chat'}: ${s.title}`}
      onClick={() => choose(s)}
    >
      <span
        className={`session-dot ${data.runtime.find((r) => r.id === s.nativeSessionId)?.container_status === 'running' ? 'running' : ''}`}
      />
      <span>{s.title}</span>
      <UnreadBadge count={unreadCount(s.id)} />
      {s.archived && (
        <span
          className="archived-mark"
          title="Archived chat"
          aria-label="Archived chat"
        >
          <Icon name="archive" size={12} />
        </span>
      )}
      {s.origin === 'openclaw' && (
        <span
          className="imported-mark"
          title="Imported from OpenClaw — reference history. Open the chat to continue it in NanoClaw."
          aria-label="Imported from OpenClaw"
        >
          <Icon name="clock" size={12} />
        </span>
      )}
      {s.pinned && (
        <span title="Pinned chat — use Unpin session in the toolbar to unpin.">
          <Icon name="pin" size={12} />
        </span>
      )}
    </button>
    <button
      className="session-archive"
      aria-label={`${s.archived ? 'Unarchive' : 'Archive'} session: ${s.title}`}
      title={s.archived ? 'Unarchive session' : 'Archive session'}
      onClick={() => void mutateSession({ archived: !s.archived }, s.id)}
    >
      <Icon name={s.archived ? 'unarchive' : 'archive'} size={15} />
    </button>
    </div>
  );
  const groupRow = (p: Project | null) => {
    const id = p?.id ?? 'unassigned';
    const sessions = agentSessions.filter((s) => s.projectId === (p?.id ?? null) && !s.pinned);
    const folded = collapsed[id] ?? false;
    return (
      <section className="project-group" key={id}>
        <div className={`project-row ${projectId === p?.id && !sessionId ? 'selected' : ''}`}>
          <button
            title={`${folded ? 'Show' : 'Hide'} chats in ${p?.name ?? 'Unassigned'}`}
            className="collapse-project"
            aria-label={`${folded ? 'Expand' : 'Collapse'} ${p?.name ?? 'Unassigned'}`}
            aria-expanded={!folded}
            onClick={() => {
              const next = { ...collapsed, [id]: !folded };
              setCollapsed(next);
              localStorage.setItem('ws.collapsed', JSON.stringify(next));
            }}
          >
            <span className={folded ? '' : 'rotated'}>
              <Icon name="chevron" size={12} />
            </span>
          </button>
          <button
            title={p ? `Open ${p.name} conversations` : 'Return to the workspace overview'}
            className="project-name"
            onClick={() => {
              setProjectId(p?.id ?? null);
              setSessionId(null);
            }}
          >
            <Icon name={p ? 'folder' : 'chat'} size={16} />
            <span>{p?.name ?? 'Unassigned'}</span>
            <small>{sessions.length || ''}</small>
          </button>
          {p && (
            <button
              className="project-new-session"
              title={`Start a new session in ${p.name}`}
              aria-label={`New session in ${p.name}`}
              disabled={creatingSession}
              onClick={() => void create(p.id)}
            >
              <Icon name="plus" size={15} />
            </button>
          )}
          {p && (
            <button
              className="project-options"
              title={`Edit settings for ${p.name}`}
              aria-label={`Settings for ${p.name}`}
              onClick={() => openProjectForm(p)}
              aria-haspopup="dialog"
            >
              <Icon name="more" size={15} />
            </button>
          )}
        </div>
        {!folded && (
          <div className="project-sessions">
            {sessions.map(sessionRow)}
            {!sessions.length && p && (
              <button
                title="Start a conversation in this project"
                className="empty-project-session"
                disabled={creatingSession}
                onClick={() => void create(p.id)}
              >
                <Icon name="plus" size={13} />
                New session
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <HomeDirectory.Provider value={data.homeDirectory}>
    <div
      className={`workspace-shell ${mobileNav ? 'mobile-nav-open' : ''} ${panel && sessionId ? 'with-context' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px`, '--context-width': `${contextWidth}px` } as React.CSSProperties}
      onDragEnter={e => { if(Array.from(e.dataTransfer.types).includes('Files') && canAttachFiles && !(e.target as Element).closest?.('[role=dialog]')) { e.preventDefault();fileDragDepth.current++;setDraggingFiles(true); } }}
      onDragLeave={e => { if(Array.from(e.dataTransfer.types).includes('Files')) { fileDragDepth.current=Math.max(0,fileDragDepth.current-1);if(!fileDragDepth.current)setDraggingFiles(false); } }}
      onDragOver={e => { if(Array.from(e.dataTransfer.types).includes('Files')) {e.preventDefault();e.dataTransfer.dropEffect=canAttachFiles&&!(e.target as Element).closest?.('[role=dialog]')?'copy':'none';} }}
      onDragEnd={() => {fileDragDepth.current=0;setDraggingFiles(false);}}
      onDrop={e => {
        if(!Array.from(e.dataTransfer.types).includes('Files'))return;
        e.preventDefault();fileDragDepth.current=0;setDraggingFiles(false);
        if(!canAttachFiles || (e.target as Element).closest?.('[role=dialog]'))return notify(sending?'Wait for this message to send before adding files.':'Open a conversation before attaching files.');
        if(sending)return notify('Wait for this message to send before adding files.');
        const {files,folders}=transferFiles(e.dataTransfer);
        if(folders)notify('Folders are not file attachments. Use Folders to attach a working directory.');
        void addFiles(files);
      }}
    >
      {quoting.toolbar}
      <AmbientBackground preset={appearance.themePreset} mode={appearanceMode} motion={appearance.ambientMotion} />
      {mobileNav && (
        <button
          title="Close the navigation drawer"
          className="mobile-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className="sidebar" aria-label="Sessions">
        <div className="sidebar-top">
          <a
            className="workspace-brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setSessionId(null);
              setProjectId(null);
            }}
          >
            <Mark />
            <span>Workspace</span>
            <span className="brand-sub">NANOCLAW</span>
          </a>
          <div className="agent-switcher-wrap">
            <button
              title={agentMenu ? 'Close the agent picker' : 'Choose which agent’s workspace to view'}
              className={`agent-switcher ${agentMenu ? 'open' : ''}`}
              aria-label="Switch agent"
              aria-expanded={agentMenu}
              onClick={() => setAgentMenu(!agentMenu)}
            >
              <Avatar agent={agent} />
              <span>
                <strong>{agent?.name}</strong>
                <small>
                  {agent?.provider ?? 'Agent'}
                  <i className="status-dot" />
                </small>
              </span>
              <Icon name="down" size={15} />
            </button>
            {agentMenu && (
              <div className="agent-menu">
                {data.agents.map((a) => (
                  <div className="notification-agent-entry" key={a.id}>
                    <button
                      title={`Switch to ${a.name}’s workspace`}
                      key={a.id}
                      className={a.id === agent?.id ? 'selected' : ''}
                      onClick={() => {
                        setAgentId(a.id);
                        setSessionId(null);
                        setProjectId(null);
                        setAgentMenu(false);
                      }}
                    >
                      <Avatar agent={a} small />
                      <span>{a.name}</span>
                      {a.id === agent?.id && <Icon name="check" size={15} />}
                    </button>
                    <button
                      className="notification-agent-bell"
                      aria-label={`Notifications for ${a.name}`}
                      title={`Notifications for ${a.name}`}
                      onClick={() => {
                        setNotificationTarget({ scope: 'agent', id: a.id, name: a.name });
                        setAgentMenu(false);
                      }}
                    >
                      <Bell
                        muted={notifications.settings?.preferences.some(
                          (p) => p.scope === 'agent' && p.id === a.id && p.mode === 'muted',
                        )}
                      />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            title="Start a new conversation in Unassigned"
            className="new-session-button"
            disabled={creatingSession}
                onClick={() => void create(null)}
          >
            <Icon name="plus" size={17} />
            <span>New conversation</span>
            <kbd>↵</kbd>
          </button>
          <button
            title="Search project names and conversation messages"
            className="sidebar-search"
            onClick={() => setModal('search')}
          >
            <Icon name="search" size={17} />
            <span>Search anything</span>
            <kbd>⌘ K</kbd>
          </button>
          <button
            className="notification-inbox-button"
            title="Recent activity and notification controls"
            onClick={() => setModal('activity')}
          >
            <Bell muted={notifications.settings?.global.mode !== 'on'} />
            <span>Activity</span>
            {notifications.feed.badge > 0 && <span className="notification-count">{notifications.feed.badge}</span>}
          </button>
        </div>
        <div className="sidebar-scroll" role="region" aria-label="Project and session list" tabIndex={0}>
          {pinned.length > 0 && (
            <div className="pinned-section">
              <div className="nav-label">Pinned</div>
              {pinned.map(sessionRow)}
            </div>
          )}
          <div className="project-section-heading">
            <span className="nav-label">Projects</span>
            <IconButton
              tooltip="Create a project to organize conversations"
              icon="plus"
              label="New project"
              onClick={() => openProjectForm()}
            />
          </div>
          {data.projects.filter((p) => !p.archived).map(groupRow)}
          {groupRow(null)}
          {!data.projects.length && (
            <button
              title="Create a project to organize conversations"
              className="create-first-project"
              onClick={() => openProjectForm()}
            >
              <Icon name="folder" size={19} />
              <span>Create your first project</span>
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
        <div className="sidebar-footer">
          {data.pending?.length > 0 && (
            <button
              title="Review questions and approvals awaiting your answer"
              className="archive-toggle"
              onClick={() => setModal('requests')}
            >
              <Icon name="shield" size={16} />
              Needs your answer<span>{data.pending.length}</span>
            </button>
          )}
          <button
            className={`archive-toggle ${showArchive ? 'active' : ''}`}
            role="switch"
            aria-checked={showArchive}
            aria-label="Show archived chats"
            title={showArchive ? 'Hide archived chats from the list' : 'Show archived chats alongside active chats'}
            onClick={() => {
              const next = !showArchive;
              setShowArchive(next);
              localStorage.setItem('ws.show-archive', String(next));
            }}
          >
            <Icon name="archive" size={16} />
            Show archived chats
            <span className="archive-switch" aria-hidden="true" />
          </button>

          <div className="footer-bottom">
            <span className="connection">
              <i className={`status-dot ${online ? '' : 'offline'}`} />
              {online ? (data.connected ? 'Connected' : 'Isolated preview') : 'Reconnecting'}
            </span>
            <IconButton
              tooltip="Configure utility models, appearance, access and imports"
              icon="settings"
              label="Workspace settings"
              onClick={() => setModal('settings')}
            />
          </div>
        </div>
      </aside>
      <div
        className="resize-handle sidebar-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={(e) => resize(e, 'sidebar')}
      />
      <main className="main-area">
        {draggingFiles && <div className="attachment-drop-overlay" role="status"><div><Icon name="paperclip" size={32}/><strong>Drop files to attach</strong><span>Up to 10 files · 20 MB total</span></div></div>}
        <header className="main-header">
          <button
            title={mobileNav ? 'Close projects and conversations' : 'Open projects and conversations'}
            className="mobile-nav-toggle icon-button"
            aria-label="Open projects and sessions"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Icon name="panel" />
          </button>
          <div className="breadcrumbs">
            <button
              title="Return to this agent’s workspace overview"
              onClick={() => {
                setSessionId(null);
                setProjectId(null);
              }}
            >
              <Icon name="chat" size={17} />
              <span>{agent?.name}</span>
            </button>
            <Icon name="chevron" size={13} />
            {project && current && (
              <>
                <button
                  title={`Open the ${project.name} project overview`}
                  onClick={() => {
                    setProjectId(project.id);
                    setSessionId(null);
                  }}
                >
                  <span>{project.name}</span>
                </button>
                <Icon name="chevron" size={13} />
              </>
            )}
            {current ? (
              <button
                title="Rename this conversation"
                className="session-title"
                onClick={() => {
                  setRename(current.title);
                  setModal('rename');
                }}
              >
                {current.title}
              </button>
            ) : (
              <span>{project?.name ?? 'Overview'}</span>
            )}
          </div>
          <div className="header-actions">
            <button
              className={`icon-button mobile-activity ${current ? 'is-session' : ''}`}
              aria-label="Recent activity"
              title="Recent activity"
              onClick={() => setModal('activity')}
            >
              <Bell />
              {notifications.feed.badge > 0 && <span className="notification-count">{notifications.feed.badge}</span>}
            </button>
            {!data.connected && <span className="preview-badge">Preview</span>}
            {current && (
              <>
                <button
                  className="icon-button"
                  title={
                    notifications.settings?.effective[current.id]?.enabled
                      ? 'Session notifications on'
                      : `Session notifications muted${notifications.settings?.effective[current.id]?.source ? ` by ${notifications.settings.effective[current.id].source}` : ''}`
                  }
                  aria-label="Session notifications"
                  onClick={() => setNotificationTarget({ scope: 'session', id: current.id, name: current.title })}
                >
                  <Bell muted={!notifications.settings?.effective[current.id]?.enabled} />
                </button>
                <IconButton
                  tooltip={
                    current.pinned ? 'Remove this chat from the pinned list' : 'Keep this chat in the pinned list'
                  }
                  icon="pin"
                  label={current.pinned ? 'Unpin session' : 'Pin session'}
                  active={current.pinned}
                  onClick={() => void mutateSession({ pinned: !current.pinned })}
                />
                <IconButton
                  tooltip={
                    current.archived
                      ? 'Restore this chat to the active list'
                      : 'Archive this chat without deleting its history'
                  }
                  icon="archive"
                  label={current.archived ? 'Restore session' : 'Archive session'}
                  onClick={() => void mutateSession({ archived: !current.archived })}
                />
                <IconButton
                  tooltip="Change this conversation’s project, folders and model"
                  icon="more"
                  label="Session settings"
                  onClick={() => {
                    setSessionFolders(current.directories);
                    setSessionPrimary(current.primaryDirectoryId);
                    setModel(current.model ?? '');
                    setEffort(current.effort ?? '');
                    setModal('session-settings');
                  }}
                />
                <span className="header-divider" />
                <IconButton
                  tooltip={
                    panel ? 'Hide conversation notes, folders and files' : 'Show conversation notes, folders and files'
                  }
                  icon="panel"
                  label={panel ? 'Close context panel' : 'Open context panel'}
                  active={panel}
                  onClick={() => {
                    setPanel(!panel);
                    localStorage.setItem('ws.panel', panel ? 'closed' : 'open');
                  }}
                />
              </>
            )}
          </div>
        </header>
        {connectionIssue && (
          <div className="connection-notice" role="status">
            <span>{connectionIssue} Reconnecting automatically. Your draft is kept.</span>
            <button type="button" className="text-button" onClick={() => void refresh()}>Retry now</button>
          </div>
        )}

        {sessionId ? (
          <>
            <div
              className="conversation"
              role="region"
              aria-label="Conversation history"
              tabIndex={0}
              ref={scroll}
              onScroll={(e) => {
                const el = e.currentTarget;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
              }}
            >
              {detail ? (
                <div className="conversation-inner">
                  {detail.next && (
                    <button
                      title="Load older messages in this conversation"
                      className="load-earlier"
                      onClick={async () => {
                        try {
                          const earlier = await api<Detail>(
                            `/sessions/${sessionId}?before=${encodeURIComponent(detail.next!)}`,
                          );
                          nearBottom.current = false;
                          setDetail({
                            ...detail,
                            next: earlier.next,
                            activitySummaries: {...earlier.activitySummaries,...detail.activitySummaries},
                            messages: [...earlier.messages, ...detail.messages],
                          });
                        } catch (e) {
                          notify(String(e));
                        }
                      }}
                    >
                      <Icon name="clock" size={15} />
                      Earlier messages
                    </button>
                  )}
                  {current?.origin === 'openclaw' && (
                    <div className="import-notice">
                      <Icon name="archive" size={16} />
                      <span>OpenClaw reference history</span>
                      <button
                        title="Start a NanoClaw conversation using this imported history"
                        className="text-button"
                        disabled={creatingSession}
                onClick={() => void create(current.projectId, current.id)}
                      >
                        Continue in NanoClaw
                        <Icon name="arrow" size={14} />
                      </button>
                    </div>
                  )}
                  {!detail.messages.length && (
                    <div className="conversation-start">
                      <Avatar agent={agent} />
                      <h1>A fresh thread.</h1>
                      <p>{project ? project.name : agent?.name}</p>
                      {current?.directories.length ? (
                        <div className="folder-chips">
                          {current.directories.map((d) => (
                            <span key={d.id}>
                              <Icon name="folder" size={14} />
                              <DirectoryPath path={d.path} />
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                  {messageGroups(detail.messages).map((group) =>
                    group.every(isToolOnly) ? (
                      <details className="live-tools history-tools" key={group[0].id}>
                        <summary title="Expand or collapse this group of tool steps">
                          <Icon name="terminal" size={15} />
                          <ActivityLabel label="Worked" summary={detail.activitySummaries?.[activityGroupKey(group)]?.count === group.length ? detail.activitySummaries[activityGroupKey(group)] : undefined} /><span>{group.reduce((n, m) => n + (m.data?.tools?.length ?? 1), 0)} {group.reduce((n, m) => n + (m.data?.tools?.length ?? 1), 0) === 1 ? 'step' : 'steps'}</span>
                          <Icon name="down" size={13} />
                        </summary>
                        <ActivitySummaryAction sessionId={sessionId!} groupKey={activityGroupKey(group)} messageIds={group.map(message=>message.id)} summary={detail.activitySummaries?.[activityGroupKey(group)]?.count === group.length ? detail.activitySummaries[activityGroupKey(group)] : undefined} notify={notify} />
                        {group.map((message) => (
                          <div className="progress-step" key={message.id} id={`message-${message.id}`}>
                            <div className="progress-step-heading">
                              <Icon name="terminal" size={14} />
                              <strong>
                                {message.data?.activityKey ? 'Tool activity' : (message.data?.toolName ?? (message.role === 'tool' ? 'Tool output' : 'Tool call'))}
                              </strong>
                              <time>{fullTime(message.timestamp)}</time>
                            </div>
                            {message.text && <ProgressContent value={message.text} />}
                            {message.data?.turnError && <ProgressContent value={message.data.turnError} label="Turn error" />}
                            {message.data?.tools?.map((tool, i) => (
                              <details className="live-tool" key={i}>
                                <summary title="Inspect the input sent to this tool">
                                  <Icon name="chevron" size={13} />
                                  <span>{tool.name}</span>
                                  <ToolInputPreview input={tool.input} />
                                  <small>{tool.status ?? 'Input'}</small>
                                </summary>
                                <ProgressContent value={tool.input} label="Input" />
                                {tool.output && <ProgressContent value={tool.output} />}
                                {tool.error && <ProgressContent value={tool.error} label="Error" />}
                              </details>
                            ))}
                          </div>
                        ))}
                      </details>
                    ) : (
                      <React.Fragment key={group[0].id}>
                        {group.map((message) => (
                          <article key={message.id} id={`message-${message.id}`} className={`message ${message.role}`}>
                            <div className="message-meta">
                              {message.role === 'user' ? (
                                <span className="you-avatar">
                                  {message.source === 'agent' ? (message.data?.sender?.[0] ?? 'A') : 'Y'}
                                </span>
                              ) : message.role === 'tool' ? (
                                <span className="tool-avatar">
                                  <Icon name="terminal" size={15} />
                                </span>
                              ) : (
                                <Avatar agent={agent} small />
                              )}
                              <strong>
                                {message.role === 'user'
                                  ? (message.source === 'web' ? 'You' : (message.data?.sender ?? (message.source === 'agent' ? 'Agent' : 'You')))
                                  : message.role === 'tool'
                                    ? (message.data?.toolName ?? 'Tool result')
                                    : agent?.name}
                              </strong>
                              <span className="message-source">
                                {message.source === 'openclaw'
                                  ? 'OpenClaw'
                                  : message.source === 'web'
                                    ? 'Web'
                                    : message.source}
                              </span>
                              <time title={fullTime(message.timestamp)}>{ago(message.timestamp)}</time>
                              {message.role === 'assistant' && current?.origin !== 'openclaw' && message.text.trim() && <button
                                type="button" className="message-copy quote-message" data-quote-action disabled={sending}
                                title="Quote selected text, or this entire message" aria-label="Quote message or selected text"
                                onPointerDown={event=>event.preventDefault()}
                                onClick={()=>quoting.quote({id:message.id,text:message.text})}>
                                <QuoteIcon />
                              </button>}
                              <button
                                title="Copy this message to the clipboard"
                                className="message-copy"
                                aria-label="Copy message"
                                onClick={() =>
                                  void navigator.clipboard.writeText(message.text).then(() => notify('Message copied.'))
                                }
                              >
                                <Icon name="copy" size={14} />
                              </button>
                            </div>
                            <div className="message-content">
                              {message.role === 'tool' ? (
                                <details className="tool-result">
                                  <summary title="Inspect this tool’s output">
                                    <Icon name="terminal" size={14} />
                                    {message.data?.toolName ?? 'Tool output'}
                                    <span>{message.text.length.toLocaleString()} characters</span>
                                  </summary>
                                  <ProgressContent value={message.text} />
                                </details>
                              ) : (
                                <RichText text={message.text} quoteId={message.role === 'assistant' ? message.id : undefined} />
                              )}{' '}
                              {message.data?.tools?.map((tool, index) => (
                                <details className="tool-result" key={index}>
                                  <summary title="Inspect the input sent to this tool">
                                    <Icon name="terminal" size={14} />
                                    {tool.name}
                                  </summary>
                                  <ProgressContent value={tool.input} label="Input" />
                                </details>
                              ))}
                              {message.files.length > 0 && (
                                <div className="message-files">
                                  {message.files.map((file) => (
                                    <a
                                      className="file-card"
                                      key={file.id}
                                      href={`/api/files/${file.id}`}
                                      download={file.name}
                                    >
                                      {file.mime?.startsWith('image/') && file.mime !== 'image/svg+xml' ? (
                                        <img src={`/api/files/${file.id}?inline=1`} alt={file.name} loading="lazy" />
                                      ) : (
                                        <Icon name="note" size={21} />
                                      )}
                                      <span>
                                        {file.name}
                                        <small>Download attachment</small>
                                      </span>
                                      <Icon name="arrow" size={15} />
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                          </article>
                        ))}
                      </React.Fragment>
                    ),
                  )}
                  {detail.live && !detail.live.archived && Object.values(detail.live.tools ?? {}).length > 0 && (
                    <details className="live-tools" open={detail.live.running}>
                      <summary title="Expand or collapse the agent’s tool activity">
                        <Icon name="terminal" size={15} />
                        <ActivityLabel label={detail.live.running ? 'Working' : 'Worked'} summary={detail.live.running ? undefined : detail.activitySummaries?.[liveActivityKey(detail.live)]} />
                        <span>{Object.values(detail.live.tools).length} {Object.values(detail.live.tools).length === 1 ? 'step' : 'steps'}</span>
                        <Icon name="down" size={13} />
                      </summary>
                      {!detail.live.running && <ActivitySummaryAction sessionId={sessionId!} groupKey={liveActivityKey(detail.live)} summary={detail.activitySummaries?.[liveActivityKey(detail.live)]} notify={notify} />}
                      {Object.values(detail.live.tools).map((tool) => (
                        <details className="live-tool" key={tool.id}>
                          <summary title="Inspect this tool’s input, output and status">
                            <Icon name="chevron" size={13} />
                            <i className={tool.status === 'running' ? 'working-dot' : 'finished-dot'} />
                            <span>{tool.name}</span>
                                  <ToolInputPreview input={tool.input} />
                            <small>{tool.status}</small>
                          </summary>
                          {tool.input !== undefined && <ProgressContent value={tool.input} label="Input" />}
                          {tool.output && <ProgressContent value={tool.output} />}
                          {tool.error && (
                            <div className="progress-error">
                              <ProgressContent value={tool.error} label="Error" />
                            </div>
                          )}
                        </details>
                      ))}
                    </details>
                  )}
                  {detail.live?.running && (
                    <div className="live-answer">
                      <div className="message-meta">
                        <Avatar agent={agent} small />
                        <strong>{agent?.name}</strong>
                        <span className="thinking-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                      {Object.values(detail.live.texts ?? {}).map((text, index) => {
                        const visible = /<message(?:\s[^>]*)?>([\s\S]*)/
                          .exec(text)?.[1]
                          ?.replace(/<\/message>[\s\S]*$/, '');
                        return visible ? <RichText key={index} text={visible} quoteId={`live:${sessionId}:${index}`} /> : null;
                      })}
                    </div>
                  )}
                  {detail.live?.error && (
                    <div className="inline-error">
                      <Icon name="shield" size={17} />
                      {detail.live.error}
                    </div>
                  )}
                  {detail.pending.map((request) => (
                    <RequestCard
                      key={request.id}
                      request={request}
                      answer={async (value) => {
                        try {
                          await api(`/requests/${request.id}`, 'POST', { value });
                          await refresh();
                        } catch (e) {
                          notify(String(e));
                        }
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="conversation-inner">
                  <div className="loading-lines">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              )}
            </div>
            {current?.origin !== 'openclaw' && (
              <div className="composer-area">
                <div
                  className={`composer ${sending ? 'sending' : ''}`}
                >
                  {attachments.length > 0 && <div className="composer-files" aria-label="Message attachments">
                    {attachments.map(file=><div className="draft-attachment" key={file.id}>
                      {file.preview?<img src={file.preview} alt=""/>:<Icon name="note" size={24}/>}
                      <span><strong title={file.name}>{file.name}</strong><small>{file.data===null?'Preparing…':fileSize(file.size)}</small></span>
                      <button type="button" title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`} disabled={sending} onClick={()=>removeAttachment(file.id)}><Icon name="close" size={15}/></button>
                    </div>)}
                  </div>}
                  {attachments.some(f=>f.mimeType.startsWith('image/')) && current && data.modelConnections.some(c=>c.models.some(m=>`${c.id}/${m.id}`===(current.model||agent?.model)&&m.image===false)) && <p className="attachment-vision-warning" role="status">This model is not configured for image input. Choose an image-capable model to analyze images.</p>}
                  {readingAttachments && <span className="attachment-status" role="status">Preparing attachments…</span>}
                  <textarea
                    ref={composer}
                    aria-label={`Message ${agent?.name}`}
                    placeholder={`Message ${agent?.name}…`}
                    value={draft}
                    onChange={(e) => updateDraft(e.target.value)}
                    onPaste={e=>{
                      const {files,folders}=transferFiles(e.clipboardData);
                      if(!files.length&&!folders)return;
                      e.preventDefault();
                      if(folders)notify('Folders are not file attachments. Use Folders to attach a working directory.');
                      if(sending)return notify('Wait for this message to send before adding files.');
                      void addFiles(files);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-left">
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files && !sending) void addFiles(e.target.files);
                          e.target.value = '';
                        }}
                      />
                      <IconButton
                        tooltip="Attach files · paste an image or drop files here"
                        icon="plus"
                        label="Attach files"
                        onClick={() => {if(!sending)fileInput.current?.click();}}
                      />
                      <button
                        title="View the folders attached to this conversation"
                        className="composer-context"
                        onClick={() => {
                          setPanel(true);
                          setPanelTab('folders');
                        }}
                      >
                        <Icon name="folder" size={15} />
                        {current?.directories.length
                          ? current.directories.length === 1
                            ? <DirectoryPath path={current.directories[0].path} />
                            : `${current.directories.length} folders`
                          : 'Folders'}
                      </button>
                    </div>
                    <div className="composer-right">
                      <SpeechButton
                        key={sessionId}
                        config={data.settings.speech}
                        request={api}
                        disabled={sending}
                        onBusy={setSpeechBusy}
                        notify={notify}
                        onText={text => {
                          const previous = draftRef.current;
                          const next = previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text;
                          setDraft(next);
                          try { localStorage.setItem(`ws.draft:${sessionId}`, next); }
                          catch { notify('Transcript added, but browser draft storage is full. Keep this conversation open until sending.'); }
                          composer.current?.focus();
                        }}
                      />
                      <button
                        className="model-selector"
                        title="Change the model and reasoning effort for this conversation"
                        onClick={() => {
                          if (!current) return;
                          setSessionFolders(current.directories);
                          setSessionPrimary(current.primaryDirectoryId);
                          setModel(current.model ?? '');
                          setEffort(current.effort ?? '');
                          setModal('session-settings');
                        }}
                      >
                        <span>{modelLabel(current?.model || agent?.model, agent)}</span>
                        <span className="effort-label">{current?.effort ?? agent?.effort ?? ''}</span>
                        <Icon name="down" size={12} />
                      </button>
                      {detail?.live?.running && (
                        <IconButton
                          tooltip="Request that the agent stop its current turn"
                          icon="stop"
                          label="Stop current turn"
                          onClick={() =>
                            void api(`/sessions/${sessionId}/cancel`, 'POST', {})
                              .then(() => notify('Stop requested.'))
                              .catch((e) => notify(String(e)))
                          }
                        />
                      )}
                      <button
                        title="Send your message and attachments"
                        className="send-button"
                        aria-label="Send message"
                        disabled={sending || speechBusy || readingAttachments || (!draft.trim() && !attachments.length)}
                        onClick={() => void send()}
                      >
                        <Icon name="send" size={18} />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="composer-footnote">
                  <span>
                    {project?.name ?? 'Unassigned'}
                    {current?.directories.length
                      ? ` · ${current.directories.length} attached ${current.directories.length === 1 ? 'folder' : 'folders'}`
                      : ''}
                  </span>
                  <span>
                    ↵ to send <i>·</i> ⇧↵ for a new line
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="overview-scroll" role="region" aria-label="Workspace overview" tabIndex={0}>
            <div className="overview">
              <div className="overview-eyebrow">
                <Avatar agent={agent} small />
                <span>{agent?.name}’s workspace</span>
              </div>
              <div className="overview-title">
                <div>
                  <h1>{project?.name ?? 'Room to do good work.'}</h1>
                  {project?.description ? (
                    <RichText text={project.description} />
                  ) : (
                    <p>
                      {project
                        ? 'Your project, in focus.'
                        : 'Your projects. Your conversations. Everything in context.'}
                    </p>
                  )}
                </div>
                <button
                  title="Start a conversation in this workspace"
                  className="button primary"
                  disabled={creatingSession}
                onClick={() => void create(project?.id ?? null)}
                >
                  <Icon name="plus" size={17} />
                  New conversation
                </button>
              </div>
              {project ? (
                <>
                  <div className="folder-chips">
                    {project.directories.map((d) => (
                      <button
                        title={`Edit project folders: ${d.path}`}
                        key={d.id}
                        onClick={() => openProjectForm(project)}
                      >
                        <Icon name="folder" size={15} />
                        <DirectoryPath path={d.path} />
                        <small>{d.readonly ? 'Read' : 'Write'}</small>
                      </button>
                    ))}
                    <button title="Edit the project brief and default folders" onClick={() => openProjectForm(project)}>
                      <Icon name="settings" size={15} />
                      Project settings
                    </button>
                  </div>
                  <div className="project-overview-grid">
                    <div>
                      <div className="section-toolbar">
                        <h3>Conversations</h3>
                        <button
                          title={
                            allProjectAgents
                              ? 'Show only this agent’s project conversations'
                              : 'Show project conversations from every agent'
                          }
                          className="tag-button"
                          onClick={() => setAllProjectAgents(!allProjectAgents)}
                        >
                          {allProjectAgents ? 'All agents' : agent?.name}
                          <Icon name="down" size={12} />
                        </button>
                      </div>
                      <div className="overview-sessions">
                        {data.sessions
                          .filter(
                            (s) =>
                              s.projectId === project.id &&
                              !s.archived &&
                              (allProjectAgents || s.agentId === agent?.id),
                          )
                          .map((s) => (
                            <button className={unreadCount(s.id) ? 'unread' : ''} title={`Open conversation: ${s.title}`} key={s.id} onClick={() => choose(s)}>
                              <Avatar agent={data.agents.find((a) => a.id === s.agentId)} small />
                              <span>
                                <strong>{s.title}</strong>
                                <small>
                                  {data.agents.find((a) => a.id === s.agentId)?.name}
                                  {s.origin === 'openclaw' ? ' · OpenClaw' : ''}
                                </small>
                                <LatestMessagePreview session={s} agents={data.agents} />
                              </span>
                              <UnreadBadge count={unreadCount(s.id)} verbose />
                              <time title={fullTime(s.latestMessage?.timestamp ?? s.updatedAt)}>{ago(s.latestMessage?.timestamp ?? s.updatedAt)}</time>
                              <Icon name="chevron" size={14} />
                            </button>
                          ))}
                      </div>
                    </div>
                    <Scratchpad
                      bounded
                      scope="project"
                      id={project.id}
                      version={data.documentVersions?.[`project:${project.id}`]}
                      jobs={data.jobs}
                      notify={notify}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="overview-section-heading">
                    <h3>Pick up where you left off</h3>
                    <span className="muted">Recent conversations</span>
                  </div>
                  <div className="recent-sessions">
                    {agentSessions.slice(0, 6).map((s) => (
                      <button className={unreadCount(s.id) ? 'unread' : ''} title={`Resume conversation: ${s.title}`} key={s.id} onClick={() => choose(s)}>
                        <span className="recent-icon">
                          <Icon name="chat" size={17} />
                        </span>
                        <span>
                          <strong>{s.title}</strong>
                          <small>{data.projects.find((p) => p.id === s.projectId)?.name ?? 'Unassigned'}</small>
                          <LatestMessagePreview session={s} agents={data.agents} />
                        </span>
                        <UnreadBadge count={unreadCount(s.id)} verbose />
                        <time title={fullTime(s.latestMessage?.timestamp ?? s.updatedAt)}>{ago(s.latestMessage?.timestamp ?? s.updatedAt)}</time>
                        <Icon name="chevron" size={14} />
                      </button>
                    ))}
                  </div>
                  <div className="overview-section-heading">
                    <h3>Projects</h3>
                    <button
                      title="Create a project to organize conversations"
                      className="text-button"
                      onClick={() => openProjectForm()}
                    >
                      <Icon name="plus" size={15} />
                      New project
                    </button>
                  </div>
                  <div className="project-cards">
                    {data.projects
                      .filter((p) => !p.archived)
                      .map((p, i) => (
                        <button
                          title={`Open the ${p.name} project overview`}
                          key={p.id}
                          className="project-card"
                          onClick={() => {
                            setProjectId(p.id);
                            setSessionId(null);
                          }}
                        >
                          <span className="project-card-icon" data-tone={i % 4}>
                            <Icon name="folder" size={21} />
                          </span>
                          <h3>{p.name}</h3>
                          <p>
                            {p.description || (!p.directories.length && 'Ready for your next idea.')}
                          </p>
                          {p.directories.length > 0 && <div className="project-directory-paths">
                            {p.directories.map(d => <DirectoryPath key={d.id} path={d.path} />)}
                          </div>}
                          <div>
                            <span>
                              {
                                data.sessions.filter(
                                  (s) => s.projectId === p.id && s.agentId === agent?.id && !s.archived,
                                ).length
                              }{' '}
                              sessions
                            </span>
                            <Icon name="arrow" size={15} />
                          </div>
                        </button>
                      ))}
                    <button
                      title="Create a project to organize conversations"
                      className="project-card new-project-card"
                      onClick={() => openProjectForm()}
                    >
                      <span className="new-project-icon">
                        <Icon name="plus" size={23} />
                      </span>
                      <h3>Start a project</h3>
                      <p>Give your work a home.</p>
                    </button>
                  </div>
                  {agent && <AgentFiles key={`files:${agent.id}`} agentId={agent.id} />}
                  {agent && <AgentSkills key={agent.id} agentId={agent.id} />}
                </>
              )}
            </div>
          </div>
        )}
      </main>
      {panel && sessionId && current && (
        <>
          <div
            className="resize-handle context-handle"
            role="separator"
            aria-label="Resize context panel"
            aria-orientation="vertical"
            onPointerDown={(e) => resize(e, 'context')}
          />
          <aside className="context-panel" aria-label="Session context">
            <div className="context-heading">
              <span>
                <Icon name="note" size={17} />
                Context
              </span>
              <IconButton
                tooltip="Hide the context panel"
                icon="close"
                label="Close context"
                onClick={() => {
                  setPanel(false);
                  localStorage.setItem('ws.panel', 'closed');
                }}
              />
            </div>
            <div className="context-tabs" role="tablist">
              {[
                ['session', 'Session'],
                ['project', 'Project'],
                ['folders', 'Folders'],
                ['files', 'Files'],
              ].map(([id, label]) => (
                <button
                  title={
                    {
                      session: 'View conversation notes and history',
                      project: 'View the shared project brief and notes',
                      folders: 'View and manage attached folders',
                      files: 'View conversation attachments',
                    }[id]
                  }
                  role="tab"
                  aria-selected={panelTab === id}
                  key={id}
                  onClick={() => setPanelTab(id)}
                >
                  {label}
                  {id === 'folders' && current.directories.length > 0 && <small>{current.directories.length}</small>}
                </button>
              ))}
            </div>
            <div className="context-body" role="region" aria-label="Context contents" tabIndex={0}>
              {panelTab === 'session' && (
                <>
                  <div className="context-session-info">
                    <span className="eyebrow">
                      {current.origin === 'openclaw' ? 'IMPORTED SESSION' : 'SESSION OVERVIEW'}
                    </span>
                    <h3>{current.title}</h3>
                    {project && (
                      <button
                        title={`View shared notes for ${project.name}`}
                        className="context-project-link"
                        onClick={() => setPanelTab('project')}
                      >
                        <Icon name="folder" size={14} />
                        {project.name}
                        <Icon name="chevron" size={12} />
                      </button>
                    )}
                  </div>
                  <Scratchpad
                    scope="session"
                    id={current.id}
                    version={data.documentVersions?.[`session:${current.id}`]}
                    jobs={data.jobs}
                    notify={notify}
                  />
                </>
              )}
              {panelTab === 'project' &&
                (project ? (
                  <>
                    <div className="context-session-info">
                      <span className="eyebrow">SHARED PROJECT</span>
                      <h3>{project.name}</h3>
                      <button
                        title="Edit the project brief and default folders"
                        className="text-button"
                        onClick={() => openProjectForm(project)}
                      >
                        Edit project
                        <Icon name="edit" size={13} />
                      </button>
                    </div>
                    {project.description && (
                      <div className="project-brief">
                        <span className="eyebrow">Project brief</span>
                        <RichText text={project.description} />
                      </div>
                    )}
                    <Scratchpad
                      scope="project"
                      id={project.id}
                      version={data.documentVersions?.[`project:${project.id}`]}
                      jobs={data.jobs}
                      notify={notify}
                    />
                  </>
                ) : (
                  <div className="context-empty">
                    <Icon name="folder" size={25} />
                    <h3>A project gives this work a home.</h3>
                    <select
                      aria-label="Assign a project"
                      value=""
                      onChange={(e) => void mutateSession({ projectId: e.target.value || null })}
                    >
                      <option value="">Choose a project</option>
                      {data.projects
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
              {panelTab === 'files' && (
                <SessionFiles id={current.id} version={detail?.messages.length ?? 0} notify={notify} />
              )}
              {panelTab === 'folders' && (
                <>
                  <div className="context-session-info">
                    <span className="eyebrow">WORKING DIRECTORIES</span>
                    <h3>
                      {current.directories.length
                        ? `${current.directories.length} attached ${current.directories.length === 1 ? 'folder' : 'folders'}`
                        : 'No folders attached'}
                    </h3>
                  </div>
                  <div className="attached-folder-list">
                    {current.directories.map((d) => (
                      <div key={d.id}>
                        <span className="folder-icon">
                          <Icon name="folder" size={20} />
                        </span>
                        <div>
                          <strong><DirectoryPath path={d.path} /></strong>
                          <span className="folder-tags">
                            {d.id === current.primaryDirectoryId && <small>Working directory</small>}
                            <small>{d.readonly ? 'Read-only' : 'Read & write'}</small>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    title="Change the folders attached to this conversation"
                    className="button secondary manage-folders"
                    onClick={() => {
                      setSessionFolders(current.directories);
                      setSessionPrimary(current.primaryDirectoryId);
                      setModel(current.model ?? '');
                      setEffort(current.effort ?? '');
                      setModal('session-settings');
                    }}
                  >
                    <Icon name="folder" size={16} />
                    Manage folders
                  </button>
                  <div className="context-note">
                    <Icon name="shield" size={14} />
                    <span>Folder changes apply between turns. This session keeps its own folder selection.</span>
                  </div>
                </>
              )}
            </div>
          </aside>
        </>
      )}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <IconButton
            tooltip="Dismiss this notification"
            icon="close"
            label="Dismiss notice"
            onClick={() => setNotice('')}
          />
        </div>
      )}
      {modal === 'requests' && (
        <Dialog title="Needs your answer" close={() => setModal(null)}>
          <div className="form-body" role="region" aria-label="Form fields" tabIndex={0}>
            {data.pending?.length ? (
              data.pending.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  answer={async (value) => {
                    try {
                      await api(`/requests/${request.id}`, 'POST', { value });
                      await refresh();
                    } catch (e) {
                      notify(String(e));
                      throw e;
                    }
                  }}
                />
              ))
            ) : (
              <p className="muted">All caught up.</p>
            )}
          </div>
        </Dialog>
      )}
      {notificationTarget && (
        <Dialog title={`${notificationTarget.name} · Notifications`} close={() => setNotificationTarget(null)}>
          <div className="form-body compact" role="region" aria-label="Notification settings" tabIndex={0}>
            <ScopeNotifications target={notificationTarget} settings={notifications.settings} />
          </div>
        </Dialog>
      )}
      {modal === 'activity' && (
        <Dialog title="Activity" close={() => setModal(null)} wide>
          <ActivityInbox
            feed={notifications.feed}
            settings={notifications.settings}
            choose={(id, activityId) => {
              setPendingActivity(activityId);
              const session = data.sessions.find((s) => s.id === id);
              if (session) choose(session);
              setModal(null);
            }}
            openSettings={() => setModal('notifications')}
          />
        </Dialog>
      )}
      {updateWorker && (
        <div className="notification-update" role="status">
          <span>A workspace update is ready.</span>
          <button
            className="button secondary small"
            onClick={() => {
              navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
              updateWorker.waiting?.postMessage({ type: 'activate' });
            }}
          >
            Update app
          </button>
          <button className="text-button" onClick={() => setUpdateWorker(null)}>
            Later
          </button>
        </div>
      )}
      {(modal === 'settings' || modal === 'notifications') && (
        <WorkspaceSettings
          initialTab={modal === 'notifications' ? 'notifications' : 'agents'}
          previewAppearance={setAppearancePreview}
          appearanceMode={appearanceMode}
          appearanceSaved={settings => {
            setData(previous => previous ? { ...previous, settings } : previous);
            setAppearancePreview(null);
          }}
          data={data}
          close={() => setModal(null)}
          refresh={() => void refresh()}
          notify={notify}
        />
      )}
      {modal === 'project' && (
        <ProjectForm
          project={editProject}
          close={() => setModal(null)}
          saved={(p) => {
            setProjectId(p.id);
            void refresh();
          }}
          notify={notify}
        />
      )}
      {modal === 'rename' && current && (
        <Dialog title="Rename conversation" close={() => setModal(null)}>
          <form id="rename-conversation" className="form-body" aria-label="Rename conversation" onSubmit={async (event) => {
            event.preventDefault();
            if (renameSaving || !rename.trim()) return;
            setRenameSaving(true);
            try {
              await api(`/sessions/${current.id}`, 'PATCH', {title: rename.trim()});
              setModal(null);
              await refresh();
            } catch (error) {
              notify(String(error));
            } finally {
              setRenameSaving(false);
            }
          }}>
            <label>
              Title
              <input
                data-autofocus
                value={rename}
                maxLength={200}
                disabled={renameSaving}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
                }}
              />
            </label>
          </form>
          <div className="modal-footer">
            <button
              type="button"
              title="Cancel renaming this conversation"
              className="button secondary"
              onClick={() => setModal(null)}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="rename-conversation"
              title="Save the new conversation title"
              className="button primary"
              disabled={renameSaving || !rename.trim()}
            >
              {renameSaving ? 'Saving…' : 'Save title'}
            </button>
          </div>
        </Dialog>
      )}
      {modal === 'session-settings' && current && (
        <Dialog title="Session settings" close={() => setModal(null)}>
          <div className="form-body" role="region" aria-label="Form fields" tabIndex={0}>
          <ScopeNotifications
            target={{ scope: 'session', id: current.id, name: current.title }}
            settings={notifications.settings}
          />
          <div className="notification-session-actions">
            <button className="button secondary" onClick={() => void mutateSession({ pinned: !current.pinned })}>
              {current.pinned ? 'Unpin session' : 'Pin session'}
            </button>
            <button className="button secondary" onClick={() => void mutateSession({ archived: !current.archived })}>
              {current.archived ? 'Restore session' : 'Archive session'}
            </button>
          </div>
            <label>
              Project
              <select
                value={current.projectId ?? ''}
                onChange={(e) => void mutateSession({ projectId: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {data.projects
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="profile-fields">
              <SessionModelPicker value={model} change={setModel} agent={agent} agents={data.agents} connections={data.modelConnections} validity={setModelValid} />
              <label>
                Reasoning effort
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">Agent default</option>
                  {['low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="form-help model-help" id="session-model-help">
              {modelLabel(model || agent?.model, agent)}
              {!model && ' · Using agent default'}
              {agent?.modelProvider && <>. The <code>{agent.modelProvider.id}/</code> prefix is OpenCode’s connection ID for {agent.modelProvider.label}.</>}
            </p>
            <div className="field-heading">
              <span>Session folders</span>
              <span className="muted">Independent of project defaults</span>
            </div>
            <DirectoryEditor
              runtimeDriver={current?.runtimeDriver}
              value={sessionFolders}
              change={setSessionFolders}
              primary={sessionPrimary}
              setPrimary={setSessionPrimary}
              notify={notify}
            />
          </div>
          <div className="modal-footer">
            <button
              title="Discard unsaved folder and model changes"
              className="button secondary"
              onClick={() => setModal(null)}
            >
              Cancel
            </button>
            <button
              title="Apply folder and model changes when the agent is idle"
              className="button primary"
              disabled={!modelValid}
              onClick={async () => {
                try {
                  await api(`/sessions/${current.id}`, 'PATCH', {
                    directories: sessionFolders,
                    primaryDirectoryId: sessionPrimary,
                    model: model || null,
                    effort: effort || null,
                  });
                  setModal(null);
                  await refresh();
                } catch (e) {
                  notify(String(e));
                }
              }}
            >
              Apply between turns
            </button>
          </div>
        </Dialog>
      )}
      {modal === 'search' && (
        <Dialog title="Search workspace" close={() => setModal(null)} wide>
          <div className="command-search">
            <Icon name="search" size={20} />
            <input
              aria-label="Search conversations and messages"
              placeholder="Search conversations, decisions, anything…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <kbd>ESC</kbd>
          </div>
          <div className="search-results">
            {search &&
              data.projects
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button
                    title={`Open the ${p.name} project overview`}
                    key={p.id}
                    onClick={() => {
                      setProjectId(p.id);
                      setSessionId(null);
                      setModal(null);
                    }}
                  >
                    <Icon name="folder" />
                    <span>
                      <strong>{p.name}</strong>
                      <small>Project</small>
                    </span>
                    <Icon name="arrow" size={16} />
                  </button>
                ))}
            {(search
              ? results
              : data.sessions.slice(0, 12).map((s) => ({
                  session_id: s.id,
                  title: s.title,
                  agent_id: s.agentId,
                  excerpt: data.projects.find((p) => p.id === s.projectId)?.name ?? 'Unassigned',
                }))
            ).map((result, index) => (
              <button
                title={`Open conversation: ${result.title}`}
                key={`${result.id ?? result.session_id}-${index}`}
                onClick={() => {
                  const s = data.sessions.find((s) => s.id === result.session_id);
                  if (s) choose(s);
                }}
              >
                <Icon name="chat" />
                <span>
                  <strong>{result.title}</strong>
                  <small>{result.excerpt}</small>
                </span>
                <span className="result-agent">{data.agents.find((a) => a.id === result.agent_id)?.name}</span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
            {search && !results.length && <div className="search-empty">No matching messages yet.</div>}
          </div>
          <div className="command-footer">
            <span>
              <Icon name="shield" size={13} />
              Your local workspace
            </span>
            <span>Projects · Sessions · Messages</span>
          </div>
        </Dialog>
      )}
    </div>
    </HomeDirectory.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

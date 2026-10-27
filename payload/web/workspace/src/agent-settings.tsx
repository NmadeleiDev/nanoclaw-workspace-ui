import React, { useEffect, useState } from 'react';
type Model = { id: string; context: number; output: number; image: boolean };
type Connection = { id: string; name: string; endpoint: string; apiType: string; models: Model[]; revision?: number };
type Agent = { id: string; name: string };
type Request = (route: string, method?: string, body?: unknown) => Promise<any>;
type Props = { agents: Agent[]; request: Request; onSaved: () => void };
type AgentSettings = {
  id: string;
  name: string;
  provider: string;
  model: string;
  effort: string;
  revision: string;
  providers: string[];
  connections: Connection[];
};
const runnerName = (id: string) =>
  ({ opencode: 'OpenCode', claude: 'Claude', codex: 'Codex', cursor: 'Cursor' })[id] || id;

function CredentialHandoff({ result }: { result: any }) {
  let url: URL | undefined;
  try {
    if (result?.status === 'action_required') url = new URL(result.connect_url);
  } catch {}
  if (url && !['https:', 'http:'].includes(url.protocol)) url = undefined;
  const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const macOnly = !!url && loopback(url.hostname) && !loopback(window.location.hostname);
  return (
    <div className="credential-handoff" role="status">
      <p>{result?.message}</p>
      {macOnly ? (
        <p>
          Open the credential gateway on your workspace host to connect this account. Its console is available only on the workspace host.
        </p>
      ) : (
        url && (
          <a className="button secondary" href={url.toString()} target="_blank" rel="noopener noreferrer">
            Open credential gateway{loopback(url.hostname) ? ' on this host' : ''} ↗
          </a>
        )
      )}
    </div>
  );
}

export function AgentModelSettings({ agents, request, onSaved }: Props) {
  const [id, setId] = useState(agents[0]?.id || '');
  const [draft, setDraft] = useState<AgentSettings | null>(null),
    [saved, setSaved] = useState('');
  const [handoff, setHandoff] = useState<any>(null);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setDraft(null);
    setError('');
    setMessage('');
    void request(`/agents/${id}/model-settings`)
      .then((v) => {
        if (active) {
          setDraft(v);
          setSaved(JSON.stringify(v));
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  const save = async () => {
    if (!draft) return;
    const old = JSON.parse(saved) as AgentSettings;
    const changed = draft.provider !== old.provider;
    if (
      changed &&
      !window.confirm(
        `Switch ${draft.name} to ${runnerName(draft.provider)}?\n\nThe new runner starts its own conversation context. Saved messages, files and shared memory remain. Configure its credentials in the gateway before switching.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const v = await request(`/agents/${id}/model-settings`, 'PATCH', {
        provider: draft.provider,
        model: draft.model,
        effort: draft.effort,
        revision: draft.revision,
        confirmProviderChange: changed,
      });
      setDraft(v);
      setSaved(JSON.stringify(v));
      setMessage('Agent defaults saved. They apply on the next turn. Session overrides keep their own models.');
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const connection = draft?.connections.find((c) => draft.model.startsWith(c.id + '/'));
  return (
    <section className="agent-model-settings">
      <div className="settings-section-heading">
        <div>
          <h3>Agents</h3>
          <p>Choose the runner and default chat model for each agent.</p>
        </div>
      </div>
      <label className="execution-field">
        Agent
        <select
          value={id}
          disabled={busy}
          onChange={(e) => {
            if (!draft || JSON.stringify(draft) === saved || window.confirm('Discard unsaved agent changes?'))
              setId(e.target.value);
          }}
        >
          {agents.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {!draft && !error && <p role="status">Loading agent settings…</p>}
      {draft && (
        <>
          <label className="execution-field">
            Agent runner
            <select
              value={draft.provider}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value, model: '', effort: '' })}
            >
              {draft.providers.map((p) => (
                <option value={p} key={p}>
                  {runnerName(p)}
                </option>
              ))}
            </select>
          </label>
          <p className="form-help">
            The runner executes tools and manages conversation context. Authentication is managed in NanoClaw’s
            credential gateway.
          </p>
          {draft.provider !== 'opencode' && (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  try {
                    setHandoff(
                      await request(`/agents/${id}/model-settings/credentials`, 'POST', { provider: draft.provider }),
                    );
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Manage runner credentials
              </button>
              {handoff && <CredentialHandoff result={handoff} />}
            </>
          )}
          {draft.provider === 'opencode' ? (
            <>
              <label className="execution-field">
                API connection
                <select
                  value={connection?.id || ''}
                  disabled={busy}
                  onChange={(e) => {
                    const c = draft.connections.find((c) => c.id === e.target.value);
                    setDraft({ ...draft, model: c ? `${c.id}/${c.models[0].id}` : '' });
                  }}
                >
                  <option value="" disabled>
                    Choose a connection
                  </option>
                  {draft.connections.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="execution-field">
                Default model
                <select
                  value={draft.model}
                  disabled={busy || !connection}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                >
                  {!connection && <option value="">Choose a connection first</option>}
                  {connection?.models.map((m) => (
                    <option key={m.id} value={`${connection.id}/${m.id}`}>
                      {connection.name} / {m.id}
                    </option>
                  ))}
                </select>
              </label>
              {!draft.connections.length && (
                <p className="form-help">Add an API connection in Settings → API connections first.</p>
              )}
            </>
          ) : (
            <label className="execution-field">
              Default model ID
              <input
                value={draft.model}
                disabled={busy}
                placeholder="Leave empty for the runner’s default"
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </label>
          )}
          <label className="execution-field">
            Reasoning effort
            <select
              value={draft.effort}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, effort: e.target.value })}
            >
              <option value="">Model default</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                <option value={v} key={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <p className="form-help">Save between turns. These defaults also apply to this agent’s connected channels.</p>
          <button
            className="button primary"
            disabled={busy || JSON.stringify(draft) === saved || (draft.provider === 'opencode' && !connection)}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save agent defaults'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="settings-saved">
          {message}
        </p>
      )}
    </section>
  );
}
const empty = (): Connection => ({
  id: '',
  name: '',
  endpoint: '',
  apiType: 'openai-compatible',
  models: [{ id: '', context: 0, output: 0, image: false }],
});
export function ApiConnectionSettings({ agents, request, onSaved }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [draft, setDraft] = useState<Connection | null>(null);
  const [isNew, setIsNew] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [agent, setAgent] = useState(agents[0]?.id || ''),
    [handoff, setHandoff] = useState<any>(null);
  const load = async (selected?: string) => {
    const values = await request('/model-connections');
    setConnections(values);
    setDraft(values.find((c: Connection) => c.id === selected) || values[0] || null);
    setIsNew(false);
  };
  useEffect(() => {
    let active = true;
    void request('/model-connections')
      .then((v) => {
        if (active) {
          setConnections(v);
          setDraft(v[0] || null);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const v = await request('/model-connections', isNew ? 'POST' : 'PATCH', draft);
      await load(v.id);
      setMessage('Connection saved. Agents use it on their next turn.');
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const editModel = (index: number, change: Partial<Model>) =>
    setDraft((d) => d && { ...d, models: d.models.map((m, i) => (i === index ? { ...m, ...change } : m)) });
  return (
    <section className="api-connection-settings">
      <div className="settings-section-heading">
        <div>
          <h3>API connections</h3>
          <p>Model endpoints shared by OpenCode agents. Each model keeps its own limits.</p>
        </div>
      </div>
      <div className="connection-chooser">
        <label className="execution-field">
          Connection
          <select
            value={isNew ? '__new__' : draft?.id || ''}
            disabled={busy}
            onChange={(e) => {
              if (
                draft &&
                (isNew || JSON.stringify(draft) !== JSON.stringify(connections.find((c) => c.id === draft.id))) &&
                !window.confirm('Discard unsaved connection changes?')
              )
                return;
              setDraft(connections.find((c) => c.id === e.target.value) || null);
              setIsNew(false);
              setError('');
              setMessage('');
              setHandoff(null);
            }}
          >
            {isNew && <option value="__new__">New connection</option>}
            {!connections.length && !isNew && <option value="">No connections yet</option>}
            {connections.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setDraft(empty());
            setIsNew(true);
            setError('');
            setMessage('');
            setHandoff(null);
          }}
        >
          Add connection
        </button>
      </div>
      {draft && (
        <>
          <div className="profile-fields">
            <label>
              Connection name
              <input
                value={draft.name}
                disabled={busy}
                placeholder="For example, BytePlus"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Connection ID
              <input
                value={draft.id}
                disabled={!isNew || busy}
                placeholder="byteplus"
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </label>
          </div>
          <label className="execution-field">
            API base URL
            <input
              type="url"
              value={draft.endpoint}
              disabled={busy}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            />
          </label>
          <label className="execution-field">
            API protocol
            <select
              value={draft.apiType}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, apiType: e.target.value })}
            >
              <option value="openai-compatible">OpenAI-compatible · Chat Completions</option>
              <option value="openai-responses">OpenAI-compatible · Responses</option>
              <option value="anthropic">Anthropic Messages</option>
            </select>
          </label>
          <div className="connection-model-heading">
            <h4>Available models</h4>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                setDraft({ ...draft, models: [...draft.models, { id: '', context: 0, output: 0, image: false }] })
              }
            >
              Add model
            </button>
          </div>
          {draft.models.map((m, i) => (
            <fieldset className="connection-model" key={i}>
              <legend>Model {i + 1}</legend>
              <label>
                Model ID
                <input value={m.id} disabled={busy} onChange={(e) => editModel(i, { id: e.target.value })} />
              </label>
              <div className="profile-fields">
                <label>
                  Context tokens
                  <input
                    type="number"
                    min="1"
                    max="10000000"
                    value={m.context || ''}
                    disabled={busy}
                    onChange={(e) => editModel(i, { context: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Maximum output tokens
                  <input
                    type="number"
                    min="1"
                    max={m.context}
                    value={m.output || ''}
                    disabled={busy}
                    onChange={(e) => editModel(i, { output: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="connection-model-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={m.image}
                    disabled={busy}
                    onChange={(e) => editModel(i, { image: e.target.checked })}
                  />{' '}
                  Image input
                </label>
                <button
                  className="text-button"
                  disabled={busy || draft.models.length === 1}
                  onClick={() => setDraft({ ...draft, models: draft.models.filter((_, n) => n !== i) })}
                >
                  Remove model
                </button>
              </div>
            </fieldset>
          ))}
          <button className="button primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save connection'}
          </button>
          {!isNew && (
            <button
              className="text-button"
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    `Remove ${draft.name}? Only unused connections can be removed. Gateway credentials stay in the gateway.`,
                  )
                )
                  return;
                setBusy(true);
                setError('');
                try {
                  await request(`/model-connections/${draft.id}`, 'DELETE', { revision: draft.revision });
                  await load();
                  onSaved();
                  setMessage('Connection removed.');
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove connection
            </button>
          )}
          {!isNew && (
            <section className="connection-credentials">
              <h4>Credentials</h4>
              <p>Keys stay in your credential gateway. Saving an endpoint does not grant a key.</p>
              <label className="execution-field">
                Agent to connect
                <select
                  value={agent}
                  onChange={(e) => {
                    setAgent(e.target.value);
                    setHandoff(null);
                  }}
                >
                  {agents.map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  setError('');
                  try {
                    setHandoff(await request(`/model-connections/${draft.id}/credentials`, 'POST', { agentId: agent }));
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Manage credentials
              </button>
              {handoff && <CredentialHandoff result={handoff} />}
            </section>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="settings-saved">
          {message}
        </p>
      )}
    </section>
  );
}

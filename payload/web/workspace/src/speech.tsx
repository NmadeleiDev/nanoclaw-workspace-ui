import React, { useEffect, useRef, useState } from 'react';
import { encodeSpeechWav, speechBase64 } from './speech-audio';
type Request = <T = any>(url: string, method?: string, data?: unknown, signal?: AbortSignal) => Promise<T>;
import { SPEECH_MODELS, type SpeechSettings as SpeechConfiguration } from '../../../src/modules/workspace-ui/types';
export type SpeechConfig = SpeechConfiguration;
const microphone = (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
  </svg>
);
export function SpeechSettings({
  value,
  change,
  request,
}: {
  value: SpeechConfig;
  change: (v: SpeechConfig) => void;
  request: Request;
}) {
  const [status, setStatus] = useState<any>(null);
  const [checking,setChecking] = useState(false);
  const [checkError,setCheckError] = useState('');
  const checkController = useRef<AbortController | null>(null);
  useEffect(() => {
    setCheckError('');
    return () => checkController.current?.abort();
  }, [value.backend, value.endpoint, value.executable]);
  const sameBackend = status?.backend === value.backend && (value.backend === 'mywhispr' ? status?.settings?.executable === value.executable : status?.settings?.endpoint === value.endpoint);
  useEffect(() => {
    const c = new AbortController();
    void request('/speech', 'GET', undefined, c.signal)
      .then(setStatus)
      .catch(e => {if(!c.signal.aborted)setCheckError(String(e));});
    return () => c.abort();
  }, [request]);
  return (
    <section className="speech-settings">
      <div className="settings-section-heading">
        <div>
          <h3>Speak your next message.</h3>
          <p>Transcribe locally on the workspace host. Review and edit the text before sending.</p>
        </div>
      </div>
      <label className="speech-enable">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => change({ ...value, enabled: e.target.checked })}
        />{' '}
        Enable speech input
      </label>
      <label>
        Transcription backend
        <select value={value.backend} onChange={e=>change({...value,backend:e.target.value as SpeechConfig['backend']})}>
          <option value="whisper-server">whisper.cpp · local server</option>
          <option value="mywhispr">MyWhispr · macOS CLI</option>
        </select>
      </label>
      {value.backend === 'whisper-server' && <>
        <label>Server address
          <input type="url" value={value.endpoint} onChange={e=>change({...value,endpoint:e.target.value})} placeholder="http://127.0.0.1:8080" />
        </label>
        <p>Run whisper-server on this host with your chosen model. MyWhispr is not required. Only loopback HTTP addresses are accepted; the model is selected when starting the server.</p>
      </>}
      <div>
        <button type="button" className="button secondary small" disabled={checking} onClick={()=>{
          setChecking(true);setCheckError('');
          const controller = new AbortController();
          checkController.current = controller;
          void request('/speech/check','POST',value,controller.signal)
            .then(result=>{if(!controller.signal.aborted)setStatus({...result,settings:value});})
            .catch(e=>{if(!controller.signal.aborted)setCheckError(String(e));})
            .finally(()=>{if(checkController.current===controller)setChecking(false);});
        }}>{checking ? 'Checking…' : 'Check backend'}</button>
      </div>
      <p role="status">
        {checkError || (sameBackend
          ? status.available
            ? value.backend === 'mywhispr' ? 'MyWhispr CLI is available on this host.' : 'Local whisper.cpp server is ready.'
            : value.backend === 'mywhispr' ? 'MyWhispr CLI was not found. Install it on the workspace host, or enter its full path below.' : 'The local server is not ready. Start whisper-server, then check again.'
          : 'Check this backend before saving. Checking does not change your saved settings.')}
      </p>
      {value.backend === 'mywhispr' && <>
      <label>
        Local model
        <select value={value.model} onChange={(e) => change({ ...value, model: e.target.value })}>
          {SPEECH_MODELS.map((id: string) => (
            <option key={id} value={id}>
              {(
                {
                  'large-v3-v20240930_626MB': 'Whisper Large v3 · 626 MB',
                  'large-v3-v20240930_turbo': 'Whisper Large v3 Turbo',
                  small: 'Whisper Small',
                  base: 'Whisper Base',
                  tiny: 'Whisper Tiny',
                  'parakeet-tdt-v3': 'Parakeet TDT v3',
                  'sensevoice-small': 'SenseVoice Small',
                } as Record<string, string>
              )[id] ?? id}
            </option>
          ))}
        </select>
      </label>
      </>}
      <label>
        Language
        <select value={value.language} onChange={(e) => change({ ...value, language: e.target.value })}>
          {[
            ['auto', 'Detect automatically'],
            ['en', 'English'],
            ['ru', 'Russian'],
            ['uk', 'Ukrainian'],
            ['de', 'German'],
            ['fr', 'French'],
            ['es', 'Spanish'],
            ['it', 'Italian'],
            ['pt', 'Portuguese'],
            ['zh', 'Chinese'],
            ['ja', 'Japanese'],
          ].map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {value.backend === 'mywhispr' && <label>
        MyWhispr CLI path
        <input
          value={value.executable}
          placeholder="Find automatically"
          onChange={(e) => change({ ...value, executable: e.target.value })}
        />
      </label>}
      <p>
        {value.backend === 'mywhispr' && 'Choose a model already downloaded in MyWhispr. Its CLI may download a missing model on first use. '}
        Recordings are limited to two minutes. {value.backend === 'mywhispr' ? 'Temporary CLI audio is deleted after transcription. ' : 'Audio is uploaded from memory; the local server controls its own storage. '}Audio stays on your device and workspace
        host; sending the resulting message uses your agent’s normal model provider.
      </p>
    </section>
  );
}
export function SpeechButton({
  request,
  onText,
  onBusy,
  disabled,
  config,
  notify,
}: {
  request: Request;
  onText: (text: string) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
  config: SpeechConfig;
  notify: (text: string) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'transcribing' | 'error'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Blob | null>(null);
  const state = useRef<{
    alive: boolean;
    cancelled: boolean;
    recorder?: MediaRecorder;
    stream?: MediaStream;
    timer?: ReturnType<typeof setInterval>;
    abort?: AbortController;
  }>({ alive: true, cancelled: false });
  useEffect(() => {
    state.current.alive = true;
    return () => {
      const s = state.current;
      s.alive = false;
      s.cancelled = true;
      s.abort?.abort();
      clearInterval(s.timer);
      if (s.recorder?.state === 'recording') s.recorder.stop();
      s.stream?.getTracks().forEach((t) => t.stop());
      onBusy(false);
    };
  }, []);
  const reset = () => {
    if (state.current.alive) {
      setPhase('idle');
      onBusy(false);
    }
  };
  const cancel = () => {
    recording.current = null;
    const s = state.current;
    s.cancelled = true;
    s.abort?.abort();
    clearInterval(s.timer);
    if (s.recorder?.state === 'recording') s.recorder.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    reset();
  };
  useEffect(() => {
    if (!config.enabled) cancel();
  }, [config.enabled]);
  async function start() {
    const s = (state.current = { ...state.current, cancelled: false });
    setPhase('permission');
    onBusy(true);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          'Microphone recording requires localhost or the workspace’s HTTPS address in a supported browser.',
        );
      const status = await request('/speech');
      if (s.cancelled || !s.alive || state.current !== s) return;
      if (!status.available) throw new Error('Set up the MyWhispr CLI in Settings → Speech first.');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!s.alive || s.cancelled || state.current !== s) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      s.stream = stream;
      const chunks: Blob[] = [];
      let size = 0;
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      s.recorder = recorder;
      recorder.ondataavailable = (e) => {
        if (state.current !== s || s.cancelled) return;
        if (e.data.size) {
          chunks.push(e.data);
          size += e.data.size;
          if (size > 16 * 1024 * 1024) {
            cancel();
            notify('Recording exceeded the size limit. Please try a shorter message.');
          }
        }
      };
      recorder.onerror = () => {
        if (state.current !== s || s.cancelled) return;
        cancel();
        notify('The microphone recording was interrupted. Please try again.');
      };
      recorder.onstop = () => {
        clearInterval(s.timer);
        stream.getTracks().forEach((t) => t.stop());
        if (s.alive && !s.cancelled && state.current === s)
          void transcribe(new Blob(chunks, { type: recorder.mimeType }), s);
      };
      recorder.start(1000);
      setPhase('recording');
      setSeconds(0);
      let elapsed = 0;
      s.timer = setInterval(() => {
        elapsed++;
        setSeconds(elapsed);
        if (elapsed >= 120 && recorder.state === 'recording') recorder.stop();
      }, 1000);
    } catch (e) {
      if (s.alive && !s.cancelled)
        notify(
          e instanceof Error && e.name === 'NotAllowedError'
            ? 'Microphone access was denied. Allow it in your browser’s site settings, then retry.'
            : String(e),
        );
      if (state.current === s) reset();
    }
  }
  async function transcribe(blob: Blob, s: typeof state.current) {
    recording.current = blob;
    onBusy(true);
    setPhase('transcribing');
    let succeeded = false;
    const controller = new AbortController();
    s.abort = controller;
    try {
      const context = new AudioContext();
      let audio: AudioBuffer;
      try {
        audio = await context.decodeAudioData(await blob.arrayBuffer());
      } finally {
        await context.close();
      }
      if (audio.duration > 120.5) throw new Error('Recording is longer than two minutes.');
      const renderer = new OfflineAudioContext(1, Math.min(16000 * 120, Math.ceil(audio.duration * 16000)), 16000);
      const source = renderer.createBufferSource();
      source.buffer = audio;
      source.connect(renderer.destination);
      source.start();
      const mono = await renderer.startRendering();
      if (s.cancelled || !s.alive || state.current !== s) return;
      const result = await request(
        '/speech/transcribe',
        'POST',
        { audio: speechBase64(encodeSpeechWav(mono.getChannelData(0))) },
        controller.signal,
      );
      if (s.alive && !s.cancelled) {
        onText(result.text);
        succeeded = true;
        notify('Transcript added. Review it before sending.');
      }
    } catch (e) {
      if (s.alive && !s.cancelled) notify(String(e));
    } finally {
      if (state.current === s && s.alive) {
        if (s.cancelled || succeeded) {
          recording.current = null;
          reset();
        } else {
          setPhase('error');
          onBusy(false);
        }
      }
    }
  }
  if (!config.enabled) return null;
  const active = phase !== 'idle';
  return (
    <div className={`speech-input ${active ? 'speech-active' : ''}`}>
      <span role="status" className={active ? 'speech-status' : 'sr-only'}>
        {phase === 'permission'
          ? 'Waiting for microphone…'
          : phase === 'recording'
            ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
            : phase === 'transcribing'
              ? 'Transcribing locally…'
              : phase === 'error'
                ? 'Transcription failed. Retry or cancel.'
                : ''}
      </span>
      <button
        type="button"
        className="icon-button"
        disabled={disabled || phase === 'permission' || phase === 'transcribing'}
        aria-label={
          phase === 'recording'
            ? 'Stop recording and transcribe'
            : phase === 'error'
              ? 'Retry transcription'
              : 'Dictate message'
        }
        title={phase === 'recording' ? 'Stop and transcribe' : 'Dictate a message'}
        aria-pressed={phase === 'recording'}
        onClick={() =>
          phase === 'recording'
            ? state.current.recorder?.stop()
            : phase === 'error' && recording.current
              ? void transcribe(recording.current, state.current)
              : void start()
        }
      >
        {phase === 'recording' ? <span aria-hidden="true">■</span> : microphone}
      </button>
      {active && (
        <button type="button" className="speech-cancel" onClick={cancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

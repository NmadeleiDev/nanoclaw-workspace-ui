import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { WorkspaceError } from './types.js';

import { DEFAULT_SPEECH, SPEECH_MODELS, type SpeechSettings } from './types.js';
export { DEFAULT_SPEECH } from './types.js';
export function parseSpeech(value: unknown): SpeechSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkspaceError(400, 'Invalid speech settings.');
  const input = value as Partial<SpeechSettings>;
  const v = { ...DEFAULT_SPEECH, ...input, backend: input.backend ?? 'mywhispr' };
  if (
    !['mywhispr', 'whisper-server'].includes(v.backend) ||
    typeof v.enabled !== 'boolean' ||
    typeof v.executable !== 'string' ||
    v.executable.length > 4096 ||
    v.executable.includes('\0') ||
    (v.backend === 'mywhispr' && v.executable && !path.isAbsolute(v.executable)) ||
    typeof v.model !== 'string' || v.model.length > 200 ||
    (v.backend === 'mywhispr' && !SPEECH_MODELS.includes(v.model as (typeof SPEECH_MODELS)[number])) ||
    typeof v.endpoint !== 'string' || v.endpoint.length > 4096 ||
    typeof v.language !== 'string' ||
    !/^(auto|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(v.language)
  )
    throw new WorkspaceError(400, 'Choose a supported speech model, language, and absolute CLI path.');
  const endpoint = v.backend === 'whisper-server' ? speechEndpoint(v.endpoint) : v.endpoint;
  return { enabled: v.enabled, backend: v.backend, endpoint, executable: v.executable, model: v.model, language: v.language };
}
function executable(settings: SpeechSettings): string | undefined {
  const candidates = settings.executable
    ? [settings.executable]
    : [
        path.join(os.homedir(), '.local/bin/mywhispr'),
        ...(process.env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((p) => path.join(p, 'mywhispr')),
      ];
  return candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}
export function speechEndpoint(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new WorkspaceError(400, 'Enter a local whisper.cpp server address.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new WorkspaceError(400, 'The transcription server must use a loopback HTTP address without credentials, a path, or query parameters.');
  return url.origin;
}
export async function speechStatus(settings: SpeechSettings) {
  settings = parseSpeech(settings);
  if (settings.backend === 'mywhispr')
    return { available: !!executable(settings), backend: settings.backend, settings, models: SPEECH_MODELS };
  try {
    const response = await fetch(`${settings.endpoint}/health`, {signal: AbortSignal.timeout(5000),redirect:'error'});
    const result = await boundedJson(response);
    return {available: response.ok && result.status === 'ok', backend: settings.backend, settings, models: SPEECH_MODELS};
  } catch {
    return {available:false,backend:settings.backend,settings,models:SPEECH_MODELS};
  }
}
async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkspaceError(502, 'The transcription backend returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new WorkspaceError(502, 'The transcription backend returned too much data.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new WorkspaceError(502, 'The transcription backend returned an invalid transcript.'); }
  } finally { await reader.cancel().catch(()=>{}); }
}
function transcript(value: unknown): {text: string} {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || value.text.length > 100_000)
    throw new WorkspaceError(502, 'The transcription backend returned an invalid transcript.');
  if (!value.text.trim()) throw new WorkspaceError(422, 'No speech detected. Try again closer to the microphone.');
  return {text:value.text.trim()};
}
export function speechAudio(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 5_200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new WorkspaceError(400, 'Invalid recording.');
  const b = Buffer.from(value, 'base64');
  if (
    b.length < 3244 ||
    b.length > 3_840_044 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.readUInt32LE(4) !== b.length - 8 ||
    b.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    b.readUInt32LE(16) !== 16 ||
    b.readUInt16LE(20) !== 1 ||
    b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 ||
    b.readUInt32LE(28) !== 32000 ||
    b.readUInt16LE(32) !== 2 ||
    b.readUInt16LE(34) !== 16 ||
    b.toString('ascii', 36, 40) !== 'data' ||
    b.readUInt32LE(40) !== b.length - 44 ||
    (b.length - 44) % 2
  )
    throw new WorkspaceError(400, 'Record between 0.1 seconds and two minutes of audio.');
  return b;
}
export class SpeechTranscriber {
  private busy = false;
  constructor(private root: string) {}
  async transcribe(audio: Buffer, settings: SpeechSettings, signal?: AbortSignal): Promise<{ text: string }> {
    settings = parseSpeech(settings);
    if (!settings.enabled) throw new WorkspaceError(403, 'Speech input is disabled in Settings → Speech.');
    const cli = settings.backend === 'mywhispr' ? executable(settings) : undefined;
    if (settings.backend === 'mywhispr' && !cli) throw new WorkspaceError(503, 'MyWhispr CLI was not found. Set its path in Settings → Speech.');
    if (this.busy) throw new WorkspaceError(409, 'Another recording is being transcribed. Try again shortly.');
    this.busy = true;
    let folder: string | undefined;
    try {
      if (settings.backend === 'whisper-server') {
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(audio)], {type:'audio/wav'}), 'recording.wav');
        form.set('response_format', 'json');
        form.set('language', settings.language);
        let response: Response;
        try { response = await fetch(`${settings.endpoint}/inference`, {method:'POST',body:form,signal:combined,redirect:'error'}); }
        catch {
          throw new WorkspaceError(signal?.aborted ? 499 : 503, signal?.aborted ? 'Transcription cancelled.' : 'The local transcription server could not be reached or timed out. Check Settings → Speech.');
        }
        if (!response.ok) { await response.body?.cancel(); throw new WorkspaceError(502, `The local transcription server returned HTTP ${response.status}.`); }
        try { return transcript(await boundedJson(response)); }
        catch (error) {
          if (combined.aborted) throw new WorkspaceError(signal?.aborted ? 499 : 503, signal?.aborted ? 'Transcription cancelled.' : 'Local transcription timed out.');
          throw error;
        }
      }
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      folder = fs.mkdtempSync(path.join(this.root, 'recording-'));
      const file = path.join(folder, 'audio.wav');
      fs.writeFileSync(file, audio, { mode: 0o600 });
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          cli!,
          ['transcribe', file, '--model', settings.model, '--language', settings.language, '--format', 'json'],
          { timeout: 180_000, maxBuffer: 1024 * 1024, signal },
          (error, stdout) => {
            if (error)
              reject(
                new WorkspaceError(
                  signal?.aborted ? 499 : 503,
                  signal?.aborted
                    ? 'Transcription cancelled.'
                    : 'Local transcription failed or timed out. Check that the selected model is installed in MyWhispr.',
                ),
              );
            else resolve(stdout);
          },
        );
      });
      let result: { text?: unknown };
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new WorkspaceError(502, 'MyWhispr returned an invalid transcript.');
      }
      return transcript(result);
    } finally {
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      this.busy = false;
    }
  }
}

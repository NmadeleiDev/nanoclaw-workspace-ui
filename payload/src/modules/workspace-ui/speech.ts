import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { WorkspaceError } from './types.js';

import { SPEECH_MODELS, type SpeechSettings } from './types.js';
export { DEFAULT_SPEECH } from './types.js';
export function parseSpeech(value: unknown): SpeechSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkspaceError(400, 'Invalid speech settings.');
  const v = value as SpeechSettings;
  if (
    typeof v.enabled !== 'boolean' ||
    typeof v.executable !== 'string' ||
    v.executable.length > 4096 ||
    v.executable.includes('\0') ||
    (v.executable && !path.isAbsolute(v.executable)) ||
    !SPEECH_MODELS.includes(v.model as (typeof SPEECH_MODELS)[number]) ||
    typeof v.language !== 'string' ||
    !/^(auto|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(v.language)
  )
    throw new WorkspaceError(400, 'Choose a supported speech model, language, and absolute CLI path.');
  return { enabled: v.enabled, executable: v.executable, model: v.model, language: v.language };
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
export function speechStatus(settings: SpeechSettings) {
  return { available: !!executable(settings), settings, models: SPEECH_MODELS };
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
    if (!settings.enabled) throw new WorkspaceError(403, 'Speech input is disabled in Settings → Speech.');
    const cli = executable(settings);
    if (!cli) throw new WorkspaceError(503, 'MyWhispr CLI was not found. Set its path in Settings → Speech.');
    if (this.busy) throw new WorkspaceError(409, 'Another recording is being transcribed. Try again shortly.');
    this.busy = true;
    let folder: string | undefined;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      folder = fs.mkdtempSync(path.join(this.root, 'recording-'));
      const file = path.join(folder, 'audio.wav');
      fs.writeFileSync(file, audio, { mode: 0o600 });
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          cli,
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
      if (typeof result.text !== 'string' || result.text.length > 100_000)
        throw new WorkspaceError(502, 'MyWhispr returned an invalid transcript.');
      if (!result.text.trim()) throw new WorkspaceError(422, 'No speech detected. Try again closer to the microphone.');
      return { text: result.text.trim() };
    } finally {
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      this.busy = false;
    }
  }
}

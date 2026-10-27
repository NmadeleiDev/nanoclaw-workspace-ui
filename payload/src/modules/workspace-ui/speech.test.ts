import { afterAll, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SpeechTranscriber, parseSpeech, speechAudio } from './speech.js';
import { DEFAULT_SPEECH } from './types.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
fs.mkdirSync(path.resolve('.cache'), { recursive: true });
const root = fs.mkdtempSync(path.resolve('.cache/speech-test-'));
const settings = { ...DEFAULT_SPEECH, executable: process.execPath };
afterEach(() => {
  vi.resetAllMocks();
  for (const f of fs.readdirSync(root)) fs.rmSync(path.join(root, f), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
it('accepts browser PCM WAV and rejects oversized, truncated and forged audio', () => {
  // Independently constructed 0.2-second PCM fixture, rather than the UI encoder.
  const wav = Buffer.concat([Buffer.from('524946462419000057415645666d74201000000001000100803e0000007d0000020010006461746100190000','hex'),Buffer.alloc(6400,0x40)]);
  expect(speechAudio(wav.toString('base64'))).toEqual(wav);
  for (const v of ['', 'a'.repeat(5_200_001), wav.subarray(0, 45).toString('base64')])
    expect(() => speechAudio(v)).toThrow();
  wav.writeUInt32LE(48000, 24);
  expect(() => speechAudio(wav.toString('base64'))).toThrow();
});
it('validates settings without accepting command strings or unsupported models', () => {
  expect(parseSpeech(settings)).toEqual(settings);
  for (const v of [
    { ...settings, executable: 'mywhispr --shell' },
    { ...settings, language: 'auto;exit' },
    { ...settings, model: 'unknown' },
  ])
    expect(() => parseSpeech(v)).toThrow();
});
it('executes CLI with literal arguments, returns text and removes temporary audio', async () => {
  vi.mocked(execFile).mockImplementation(((cli: any, args: any, options: any, callback: any) => {
    expect(cli).toBe(process.execPath);
    expect(args.slice(2)).toEqual(['--model', settings.model, '--language', 'auto', '--format', 'json']);
    expect(fs.statSync(args[1]).mode & 0o777).toBe(0o600);
    callback(null, JSON.stringify({ text: ' Hello Atlas. ' }), '');
  }) as any);
  const runner = new SpeechTranscriber(root);
  expect(await runner.transcribe(Buffer.alloc(44), settings)).toEqual({ text: 'Hello Atlas.' });
  expect(fs.readdirSync(root)).toEqual([]);
});
it('serializes transcription and cleans up after cancellation and failure', async () => {
  let done: any;
  vi.mocked(execFile).mockImplementation(((...args: any[]) => {
    done = args[3];
  }) as any);
  const runner = new SpeechTranscriber(root),
    controller = new AbortController();
  const pending = runner.transcribe(Buffer.alloc(44), settings, controller.signal);
  await expect(runner.transcribe(Buffer.alloc(44), settings)).rejects.toMatchObject({ status: 409 });
  controller.abort();
  done(new Error('aborted'), '', '');
  await expect(pending).rejects.toMatchObject({ status: 499 });
  expect(fs.readdirSync(root)).toEqual([]);
  vi.mocked(execFile).mockImplementation(((...args: any[]) => args[3](null, '{"text":""}', '')) as any);
  await expect(runner.transcribe(Buffer.alloc(44), settings)).rejects.toMatchObject({ status: 422 });
  expect(fs.readdirSync(root)).toEqual([]);
});
it('reports disabled or missing local transcription without spawning', async () => {
  const runner = new SpeechTranscriber(root);
  await expect(runner.transcribe(Buffer.alloc(44), { ...settings, enabled: false })).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    runner.transcribe(Buffer.alloc(44), { ...settings, executable: path.join(root, 'missing') }),
  ).rejects.toMatchObject({ status: 503 });
  expect(execFile).not.toHaveBeenCalled();
});
it('removes audio on malformed output and permits a later retry', async () => {
  const runner = new SpeechTranscriber(root);
  vi.mocked(execFile).mockImplementation(((...args: any[]) => args[3](null, 'not json', '')) as any);
  await expect(runner.transcribe(Buffer.alloc(44), settings)).rejects.toMatchObject({ status: 502 });
  expect(fs.readdirSync(root)).toEqual([]);
  vi.mocked(execFile).mockImplementation(((...args: any[]) => args[3](null, '{"text":"retry worked"}', '')) as any);
  expect(await runner.transcribe(Buffer.alloc(44), settings)).toEqual({ text: 'retry worked' });
});

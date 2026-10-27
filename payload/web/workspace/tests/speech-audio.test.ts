import { expect, it } from 'vitest';
import { encodeSpeechWav } from '../src/speech-audio';
it('encodes mono 16kHz PCM and clips samples without overflowing', () => {
  const samples = new Float32Array(1600);
  samples.set([-2, -1, 0, 1, 2, NaN]);
  const bytes = encodeSpeechWav(samples),
    view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(3200);
  expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
    -32768, -32768, 0, 32767, 32767, 0,
  ]);
  expect(() => encodeSpeechWav(new Float32Array(1599))).toThrow();
  expect(() => encodeSpeechWav(new Float32Array(120 * 16000 + 1))).toThrow();
});

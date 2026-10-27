/** Canonical mono PCM WAV accepted by the host; never depends on browser container support. */
export function encodeSpeechWav(samples: Float32Array): Uint8Array {
  if (samples.length < 1600 || samples.length > 16000 * 120)
    throw new Error('Record between 0.1 seconds and two minutes of audio.');
  const bytes = new Uint8Array(44 + samples.length * 2),
    view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const v = Math.max(-1, Math.min(1, Number.isFinite(s) ? s : 0));
    view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
  });
  return bytes;
}
export function speechBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

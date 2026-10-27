import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPEARANCE_MODES, DEFAULT_APPEARANCE, readAppearance, THEME_PRESETS } from './appearance.js';

it('reads only validated appearance fields from an untrusted browser cache', () => {
  for (const input of [
    null,
    [],
    'dark',
    { theme: 'invalid', themePreset: 'invalid', textScale: 201, ambientMotion: 'false' },
  ])
    expect(readAppearance(input)).toEqual(DEFAULT_APPEARANCE);
  expect(
    readAppearance({
      theme: 'system',
      themePreset: 'ember',
      textScale: 200,
      ambientMotion: false,
      secret: 'never-cache',
    }),
  ).toEqual({ theme: 'system', themePreset: 'ember', textScale: 200, ambientMotion: false });
});

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

describe('authored workspace palette contrast', () => {
  const css = fs.readFileSync(new URL('../../../web/workspace/src/themes.css', import.meta.url), 'utf8');
  for (const preset of THEME_PRESETS)
    for (const mode of APPEARANCE_MODES.filter((mode) => mode !== 'system')) {
      it(`${preset} / ${mode} keeps normal text and primary actions readable`, () => {
        const selector = `[data-preset='${preset}'][data-theme='${mode}']`;
        const block = css.slice(css.indexOf(selector)).split('}')[0];
        const colors = Object.fromEntries([...block.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
        for (const foreground of ['text', 'muted', 'accent', 'green', 'warning', 'info', 'danger']) {
          for (const background of ['bg', 'sidebar', 'surface', 'surface-2', 'surface-3'])
            expect(
              contrast(colors[foreground], colors[background]),
              `${foreground} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(colors['accent'], colors['accent-text'])).toBeGreaterThanOrEqual(4.5);
        const borderMix = Number(block.match(/--control-border: color-mix\(in srgb, var\(--muted\) (\d+)%/)?.[1]) / 100;
        expect(borderMix).toBeGreaterThan(0);
        const border =
          '#' +
          [1, 3, 5]
            .map((offset) =>
              Math.round(
                parseInt(colors.muted.slice(offset, offset + 2), 16) * borderMix +
                  parseInt(colors.bg.slice(offset, offset + 2), 16) * (1 - borderMix),
              )
                .toString(16)
                .padStart(2, '0'),
            )
            .join('');
        for (const background of ['bg', 'sidebar', 'surface', 'surface-2', 'surface-3'])
          expect(contrast(border, colors[background]), `control border on ${background}`).toBeGreaterThanOrEqual(3);
      });
    }
});

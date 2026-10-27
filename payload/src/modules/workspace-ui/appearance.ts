/** Browser-safe appearance contract shared by settings validation and the workspace. */
export const THEME_PRESETS = ['cosmic-night', 'ember', 'northern-lights', 'classic'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
export const APPEARANCE_MODES = ['dark', 'light', 'system'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export interface WorkspaceAppearance {
  theme: AppearanceMode;
  themePreset: ThemePreset;
  ambientMotion: boolean;
  textScale: number;
}

export const DEFAULT_APPEARANCE: WorkspaceAppearance = {
  theme: 'dark',
  themePreset: 'cosmic-night',
  ambientMotion: true,
  textScale: 100,
};

/** Only appearance fields may enter the local, pre-paint cache. */
export function readAppearance(input: unknown): WorkspaceAppearance {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    theme: APPEARANCE_MODES.includes(value.theme as AppearanceMode)
      ? (value.theme as AppearanceMode)
      : DEFAULT_APPEARANCE.theme,
    themePreset: THEME_PRESETS.includes(value.themePreset as ThemePreset)
      ? (value.themePreset as ThemePreset)
      : DEFAULT_APPEARANCE.themePreset,
    ambientMotion: typeof value.ambientMotion === 'boolean' ? value.ambientMotion : DEFAULT_APPEARANCE.ambientMotion,
    textScale:
      Number.isInteger(value.textScale) && Number(value.textScale) >= 100 && Number(value.textScale) <= 200
        ? Number(value.textScale)
        : DEFAULT_APPEARANCE.textScale,
  };
}

import { useEffect, useLayoutEffect, useState } from 'react';
import {
  readAppearance,
  THEME_PRESETS,
  type WorkspaceAppearance,
  type ThemePreset,
} from '../../../src/modules/workspace-ui/appearance.js';
import './themes.css';

export type { WorkspaceAppearance };

export const PRESET_DETAILS: Record<ThemePreset, { name: string; description: string }> = {
  'cosmic-night': { name: 'Cosmic Night', description: 'Violet clouds. A little room to dream.' },
  ember: { name: 'Ember', description: 'Copper light beneath a warm, quiet sky.' },
  'northern-lights': { name: 'Northern Lights', description: 'Cool slate and a soft aurora.' },
  classic: { name: 'Classic', description: 'Familiar, focused and understated.' },
};

function cachedAppearance(): WorkspaceAppearance {
  try {
    return readAppearance(JSON.parse(localStorage.getItem('ws.appearance') ?? 'null'));
  } catch {
    return readAppearance(null);
  }
}

/** One owner applies saved settings or the open dialog's reversible draft. */
export function useWorkspaceAppearance(saved: WorkspaceAppearance | undefined, draft: WorkspaceAppearance | null) {
  const [cached] = useState(cachedAppearance);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const appearance = readAppearance(draft ?? saved ?? cached);
  const mode = appearance.theme === 'system' ? (systemDark ? 'dark' : 'light') : appearance.theme;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.dataset.preset = appearance.themePreset;
    root.dataset.ambientMotion = String(appearance.ambientMotion);
    root.dataset.largeText = String(appearance.textScale >= 150);
    root.style.fontSize = `${appearance.textScale}%`;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  }, [mode, appearance.themePreset, appearance.ambientMotion, appearance.textScale]);
  useEffect(() => {
    if (!saved) return;
    try {
      localStorage.setItem('ws.appearance', JSON.stringify(readAppearance(saved)));
    } catch {
      /* Browser storage can be disabled; the server remains authoritative. */
    }
  }, [saved?.theme, saved?.themePreset, saved?.ambientMotion, saved?.textScale]);
  return { appearance, mode };
}

/** Miniatures use the exact same scoped tokens as the workspace, without live canvases. */
export function PresetChoices({
  value,
  mode,
  change,
}: {
  value: ThemePreset;
  mode: 'light' | 'dark';
  change: (value: ThemePreset) => void;
}) {
  return (
    <fieldset className="appearance-presets">
      <legend>Workspace theme</legend>
      <div className="preset-grid">
        {THEME_PRESETS.map((id) => (
          <label className="preset-option" key={id}>
            <input type="radio" name="workspace-preset" value={id} checked={value === id} onChange={() => change(id)} />
            <span className="preset-card">
              <span className="preset-miniature theme-scope" data-preset={id} data-theme={mode} aria-hidden="true">
                <span className="preset-sky" />
                <span className="preset-mini-sidebar">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="preset-mini-content">
                  <b />
                  <span>
                    <i />
                    <i />
                  </span>
                  <em />
                </span>
              </span>
              <span className="preset-name">
                {PRESET_DETAILS[id].name}
                <span className="preset-check" aria-hidden="true">
                  ✓
                </span>
              </span>
              <span className="preset-description">{PRESET_DETAILS[id].description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

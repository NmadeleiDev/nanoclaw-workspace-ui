import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPEARANCE_MODES,
  THEME_PRESETS,
  DEFAULT_APPEARANCE,
  readAppearance,
} from '../../src/modules/workspace-ui/appearance.js';

// Blocking external script: apply cached appearance before CSS paints, under script-src 'self'.
const appearanceInit = `(()=>{const APPEARANCE_MODES=${JSON.stringify(APPEARANCE_MODES)},THEME_PRESETS=${JSON.stringify(THEME_PRESETS)},DEFAULT_APPEARANCE=${JSON.stringify(DEFAULT_APPEARANCE)};let value=null;try{value=JSON.parse(localStorage.getItem('ws.appearance'))}catch{}const appearance=(${readAppearance.toString()})(value),root=document.documentElement;root.dataset.theme=appearance.theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):appearance.theme;root.dataset.preset=appearance.themePreset;root.dataset.ambientMotion=String(appearance.ambientMotion);root.dataset.largeText=String(appearance.textScale>=150);root.style.fontSize=appearance.textScale+'%';})();`;
const appearanceAsset = `assets/appearance-init-${createHash('sha256').update(appearanceInit).digest('hex').slice(0, 12)}.js`;

export default defineConfig({
  plugins: [
    {
      name: 'workspace-appearance-init',
      transformIndexHtml() {
        return [{ tag: 'script', attrs: { src: `/${appearanceAsset}` }, injectTo: 'head-prepend' }];
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: appearanceAsset, source: appearanceInit });
      },
      configureServer(server) {
        server.middlewares.use(`/${appearanceAsset}`, (_req, res) => {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(appearanceInit);
        });
      },
    },
    {
      name: 'workspace-worker-version',
      writeBundle(options, bundle) {
        const version = createHash('sha256')
          .update(JSON.stringify(Object.keys(bundle).sort()))
          .digest('hex')
          .slice(0, 16);
        const worker = path.resolve(options.dir ?? 'dist', 'sw.js');
        fs.writeFileSync(worker, fs.readFileSync(path.resolve('public/sw.js'), 'utf8').replace('__BUILD__', version));
      },
    },
  ],
});

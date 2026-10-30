# Notices and design references

NanoClaw core integration and copied upstream source retain the MIT notice in `LICENSE` (copyright 2026 Gavriel). Dependencies are installed separately and retain their own licenses; direct versions and registry-reported licenses are listed in `dependency-review.json`. In particular, Web Push is MPL-2.0 rather than MIT.

The visual work credits these public design references and adaptations:

- Serafim / serafimcloud: [Cosmic Night](https://21st.dev/community/themes/cosmic-night), [Darkmatter](https://21st.dev/community/themes/darkmatter), [Northern Lights](https://21st.dev/community/themes/northern-lights) color systems.
- Ali Imam / designali-in: [Starfield](https://21st.dev/@designali-in/components/starfield-1).
- Pulkit / pulkitxm: [Aurora Background](https://21st.dev/@pulkitxm/components/aurora-background).
- Chánh Đại / ncdai: [Theme Switcher](https://21st.dev/@ncdai/components/theme-switcher-1), with [original component page](https://chanhdai.com/components/theme-switcher-component).

The frontend uses its own system-CSS controls, application-specific tokens and bounded ambient rendering rather than installing those catalog components as dependencies. Original authorship is retained in source comments. These credits do not relicense third-party work. No commercial component kit or remotely fetched runtime code is bundled.

PDF previews use Mozilla PDF.js (`pdfjs-dist` 6.4.299), licensed under Apache-2.0. Its worker and display code are bundled locally. See https://github.com/mozilla/pdf.js/blob/master/LICENSE .

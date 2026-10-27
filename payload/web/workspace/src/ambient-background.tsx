/** Adapted from 21st designali-in/Starfield and pulkitxm/Aurora Background.
 * Sparse, bounded drift replaces the original warp and full-speed animation.
 * CSS clouds remain visible if a browser cannot create a canvas context.
 */
import { useEffect, useRef } from 'react';
import type { ThemePreset } from '../../../src/modules/workspace-ui/appearance.js';

export function AmbientBackground({
  preset,
  mode,
  motion,
}: {
  preset: ThemePreset;
  mode: 'light' | 'dark';
  motion: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = host.current;
    const surface = canvas.current;
    const ctx = surface?.getContext('2d');
    if (preset === 'classic' || !element || !surface || !ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const color = getComputedStyle(element).getPropertyValue('--star').trim();
    const stars = Array.from({ length: 110 }, (_, i) => ({
      x: (i * 0.61803398875 + 0.13) % 1,
      y: (i * i * 0.12731 + i * 0.317 + 0.07) % 1,
      radius: 0.45 + (i % 5) * 0.16,
      depth: 0.35 + (i % 7) / 10,
    }));
    let width = 0,
      height = 0,
      frame = 0,
      last = 0,
      elapsed = 0;
    const draw = () => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      for (const [i, star] of stars.entries()) {
        if (width < 768 && i % 2) continue;
        ctx.globalAlpha = 0.22 + star.depth * 0.35;
        ctx.beginPath();
        ctx.arc(
          (star.x * width + elapsed * star.depth * 1.6) % width,
          (star.y * height + elapsed * star.depth * 0.5) % height,
          star.radius,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      if (now - last >= 1000 / 24) {
        elapsed += last ? Math.min((now - last) / 1000, 0.1) : 0;
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      last = 0;
      const paused = !motion || reduced.matches || document.hidden;
      element.dataset.paused = String(paused);
      draw();
      if (!paused) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    sync();
    reduced.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reduced.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [preset, mode, motion]);
  if (preset === 'classic') return null;
  return (
    <div className="ambient-background" ref={host} aria-hidden="true" data-paused="true">
      <div className="ambient-clouds" />
      <canvas ref={canvas} />
      <div className="ambient-reading-shade" />
    </div>
  );
}

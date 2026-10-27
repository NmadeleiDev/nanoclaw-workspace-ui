import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { it, expect, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
const root = path.resolve('web/workspace/public');
function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const context = {
    self: {
      location: { origin: 'https://mac.test.ts.net:8443' },
      registration: { showNotification },
      navigator: { setAppBadge: vi.fn(async () => {}) },
      clients: { matchAll: async () => [], openWindow },
      addEventListener: (kind: string, fn: any) => {
        handlers[kind] = fn;
      },
    },
    URL,
    Response,
    fetch: vi.fn(),
    caches: {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
  return { ...context, handlers, showNotification, openWindow };
}
it('provides a standalone app with full-size icons and no pairing credentials in launch URLs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', scope: '/', id: '/' });
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(root, icon.src));
    expect(bytes.readUInt32BE(16)).toBe(Number(icon.sizes.split('x')[0]));
  }
  expect(fs.readFileSync('web/workspace/index.html', 'utf8')).toContain('viewport-fit=cover');
});
it('always displays a visible notification without depending on an authenticated fetch', async () => {
  const w = worker();
  let work: Promise<unknown> | undefined;
  w.handlers.push({
    data: {
      json: () => ({
        web_push: 8030,
        notification: { title: 'Assistant', body: 'Reply', navigate: 'https://evil.test/steal', app_badge: '2' },
      }),
    },
    waitUntil: (p: Promise<unknown>) => (work = p),
  });
  await work;
  expect(w.showNotification).toHaveBeenCalledTimes(1);
  expect(w.showNotification.mock.calls[0]).toMatchObject([
    'Assistant',
    { body: 'Reply', data: { navigate: 'https://mac.test.ts.net:8443' } },
  ]);
  expect(w.fetch).not.toHaveBeenCalled();
});
it('does not intercept or cache private APIs, attachments, or external resources', () => {
  const w = worker();
  for (const url of [
    'https://mac.test.ts.net:8443/api/bootstrap',
    'https://mac.test.ts.net:8443/api/files/private',
    'https://external.test/assets/a.js',
  ]) {
    const respondWith = vi.fn();
    w.handlers.fetch({ request: { url, method: 'GET' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
});
it('restricts notification click destinations to the private app origin', async () => {
  const w = worker();
  let work: Promise<unknown> | undefined;
  w.handlers.notificationclick({
    notification: { close: () => {}, data: { navigate: 'https://evil.test/' } },
    waitUntil: (p: Promise<unknown>) => (work = p),
  });
  await work;
  expect(w.openWindow).toHaveBeenCalledWith('https://mac.test.ts.net:8443');
});
it('encrypts real web-push payloads and signs VAPID requests for APNs', () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const keys = webpush.generateVAPIDKeys();
  const details = webpush.generateRequestDetails(
    {
      endpoint: 'https://web.push.apple.com/test',
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    },
    JSON.stringify({
      web_push: 8030,
      notification: { title: 'Assistant', body: 'PRIVATE_PREVIEW', navigate: 'https://mac.test.ts.net:8443' },
    }),
    {
      TTL: 60,
      vapidDetails: { subject: 'https://mac.test.ts.net:8443', publicKey: keys.publicKey, privateKey: keys.privateKey },
    },
  );
  expect(details.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: 60 });
  expect(details.headers.Authorization).toMatch(/^vapid /);
  expect(details.body?.toString()).not.toContain('PRIVATE_PREVIEW');
});

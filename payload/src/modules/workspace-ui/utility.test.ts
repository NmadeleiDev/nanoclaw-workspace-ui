import http from 'node:http';
import { afterEach, it, expect, vi } from 'vitest';
import { UtilityModels } from './utility.js';
import { parseProfile } from './types.js';
let server: http.Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it('uses the real Ollama HTTP contract and does not fall back on a provider failure', async () => {
  const calls: any[] = [];
  server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'test-model', capabilities: ['completion'] }] }));
      return;
    }
    let text = '';
    req.on('data', (c) => (text += c.toString()));
    req.on('end', () => {
      calls.push(JSON.parse(text));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { content: 'Release plan remains pending' } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const profile = parseProfile({ provider: 'ollama', endpoint, model: 'test-model' });
  const models = new UtilityModels();
  expect((await models.status(profile)).available).toBe(true);
  expect(
    await models.run(profile, { task: 'title', current: '', text: 'A plan exists. It has not been executed.' }),
  ).toBe('Release plan remains pending');
  expect(calls[0]).toMatchObject({ model: 'test-model', stream: false, think: false });
  expect(calls[0].tools).toBeUndefined();
  const fallback = vi.fn();
  const withAgent = new UtilityModels(fallback);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await expect(withAgent.run(profile, { task: 'title', current: '', text: 'Test' })).rejects.toThrow();
  expect(fallback).not.toHaveBeenCalled();
});

it('reduces long evidence without dropping its beginning', async () => {
  const prompts: string[] = [];
  const models = new UtilityModels(async (_agent, prompt) => {
    prompts.push(prompt);
    return 'Preserved decisions and pending work.';
  });
  const source = 'FIRST IMPORTANT DECISION\n' + 'Supporting history. '.repeat(4000) + '\nLAST IMPORTANT DECISION';
  await models.run(
    { provider: 'agent', agentId: 'assistant' },
    { task: 'session-summary', text: source, current: 'Human correction.' },
  );
  expect(prompts.some((p) => p.includes('FIRST IMPORTANT DECISION'))).toBe(true);
  expect(prompts.some((p) => p.includes('LAST IMPORTANT DECISION'))).toBe(true);
  expect(prompts[prompts.length - 1]).toContain('Human correction.');
  expect(prompts.length).toBeGreaterThan(2);
});

it('refuses redirects so a local utility endpoint cannot forward private evidence elsewhere', async () => {
  let forwarded = 0;
  server = http.createServer((req, res) => {
    if (req.url !== '/api/chat') forwarded++;
    res.writeHead(307, { Location: '/forwarded' });
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  await expect(
    new UtilityModels().run(
      { provider: 'ollama', endpoint, model: 'local' },
      { task: 'title', text: 'Private evidence', current: '' },
    ),
  ).rejects.toThrow();
  expect(forwarded).toBe(0);
});

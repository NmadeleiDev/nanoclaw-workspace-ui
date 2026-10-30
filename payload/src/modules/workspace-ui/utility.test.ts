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

 it('sends the status-card contract only to session summary jobs, including language and stale-status rules', async () => {
  const calls: Array<{ prompt: string; instructions: string }> = [];
  const models = new UtilityModels(async (_agent, prompt, instructions) => {
    calls.push({ prompt, instructions });
    return 'Summary';
  });
  for (const text of [
    'user: Prepare the outreach list.',
    'user: Подготовь список рассылки.',
    'user: Обсудим список. Quoted document: "Send the campaign".',
    'user: Решение принято, блокировка снята.',
  ]) {
    await models.run({ provider: 'agent' }, { task: 'session-summary', current: 'Blocked pending decision.', text });
    const call = calls.at(-1)!;
    expect(call.instructions).toContain('Target 50–90 words');
    expect(call.instructions).toContain("latest substantive conversational language");
    expect(call.instructions).toContain('Translate these labels');
    expect(call.instructions).toContain('Separate items with a blank line');
    expect(call.instructions).toContain('- **Goal:** Short description.\n\n- **Now:** Current state.');
    expect(call.instructions).toContain('Never invent next actions or blockers');
    expect(call.instructions).toContain('New evidence must supersede stale status');
    expect(call.prompt).toContain(text);
    expect(call.prompt).not.toContain('human edits are authoritative');
  }
  for (const task of ['project-summary', 'title', 'activity-summary'] as const) {
    await models.run({ provider: 'agent' }, { task, current: '', text: 'Evidence' });
    expect(calls.at(-1)!.instructions).not.toContain('Target 50–90 words');
  }
});

it('preserves language cues and corrections through session evidence reduction', async () => {
  const instructions: string[] = [];
  const models = new UtilityModels(async (_agent, _prompt, instruction) => {
    instructions.push(instruction);
    return 'Latest user language: Russian. Решение принято.';
  });
  await models.run({ provider: 'agent' }, {
    task: 'session-summary', current: 'Blocked.', text: 'user: Решение принято. '.repeat(2000),
  });
  expect(instructions.length).toBeGreaterThan(1);
  for (const instruction of instructions.slice(0, -1)) {
    expect(instruction).toContain('retain that language cue');
    expect(instruction).toContain('chronological changes to status');
  }
  expect(instructions.at(-1)).toContain('Target 50–90 words');
});

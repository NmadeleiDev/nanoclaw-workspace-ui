import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';
import { writeAtomic } from './atomic-file.js';

it('replaces an agent-planted destination symlink without writing through it', () => {
  const root = fs.mkdtempSync(path.resolve('.cache/native-atomic-'));
  try {
    const victim = path.join(root, 'victim');
    const destination = path.join(root, 'container.json');
    fs.writeFileSync(victim, 'unchanged');
    fs.symlinkSync(victim, destination);
    writeAtomic(destination, '{"host":"configuration"}');
    expect(fs.readFileSync(victim, 'utf8')).toBe('unchanged');
    expect(fs.lstatSync(destination).isFile()).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('{"host":"configuration"}');
    expect(fs.readdirSync(root).sort()).toEqual(['container.json', 'victim']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

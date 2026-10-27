import { describe, it, expect } from 'vitest';
import { matchImportAgents } from '../src/import-mapping';
describe('import agent mapping', () => {
  it('matches exact identity or a unique normalized name', () => {
    expect(
      matchImportAgents(
        [
          { id: 'main', name: 'Main' },
          { id: 'old', name: 'Build Agent' },
        ],
        [
          { id: 'main', name: 'Primary' },
          { id: 'new', name: 'Build-Agent' },
        ],
      ),
    ).toEqual({ main: 'main', old: 'new' });
  });
  it('requires an explicit choice for main and ambiguous names', () => {
    expect(
      matchImportAgents(
        [
          { id: 'main', name: 'Main' },
          { id: 'legacy', name: 'Build' },
        ],
        [
          { id: 'primary', name: 'Assistant' },
          { id: 'a', name: 'Build' },
          { id: 'b', name: 'Build' },
        ],
      ),
    ).toEqual({});
  });
  it('handles source records that have only an ID', () => {
    expect(matchImportAgents([{ id: 'build-agent' }], [{ id: 'target', name: 'Build Agent' }])).toEqual({
      'build-agent': 'target',
    });
    expect(matchImportAgents([{ id: 'main' }], [{ id: 'target', name: 'Assistant' }])).toEqual({});
  });
  it('handles Unicode names without treating punctuation-only IDs as matches', () => {
    expect(matchImportAgents([{ id: '??', name: 'Помощник' }], [{ id: 'target', name: 'Помощник' }])).toEqual({
      '??': 'target',
    });
    expect(matchImportAgents([{ id: '??', name: '!' }], [{ id: 'target', name: 'Agent' }])).toEqual({});
  });
});

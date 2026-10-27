import { expect, it } from 'vitest';
import { directoryLabel } from './path-label.js';

it('shows home-relative paths and preserves paths outside the owner home', () => {
  expect(directoryLabel('/Users/example/work/sample', '/Users/example')).toBe('~/work/sample');
  expect(directoryLabel('/Users/example', '/Users/example/')).toBe('~');
  expect(directoryLabel('/Users/example-other/project', '/Users/example')).toBe('/Users/example-other/project');
  expect(directoryLabel('/Volumes/Work/project', '/Users/example')).toBe('/Volumes/Work/project');
  expect(directoryLabel('/Users/example/project', '')).toBe('/Users/example/project');
});

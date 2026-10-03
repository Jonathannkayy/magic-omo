import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithin } from '../src/fsutil.js';

test('isWithin respects path-component boundaries', () => {
  assert.equal(isWithin('/a/b', '/a/b/x'), true);
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b', '/a/b/..foo'), true);
  assert.equal(isWithin('/a/b', '/a/beta/x'), false);
  assert.equal(isWithin('/a/b', '/a/b/../c'), false);
  assert.equal(isWithin('/a/b', '/a'), false);
});

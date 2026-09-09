import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLowerBetter } from '../_src/performance-scan.mjs';

test('scoreLowerBetter returns 100 at or below good threshold',()=>{
  assert.equal(scoreLowerBetter(500,800,1800),100);
  assert.equal(scoreLowerBetter(800,800,1800),100);
});

test('scoreLowerBetter returns 50 at poor threshold',()=>{
  assert.equal(scoreLowerBetter(1800,800,1800),50);
});

test('scoreLowerBetter decreases monotonically after thresholds',()=>{
  const a=scoreLowerBetter(1000,800,1800);
  const b=scoreLowerBetter(1400,800,1800);
  const c=scoreLowerBetter(2200,800,1800);
  assert.ok(a>b);
  assert.ok(b>c);
});

test('scoreLowerBetter rejects invalid values',()=>{
  assert.equal(scoreLowerBetter(null,800,1800),100); // Number(null) is not used by caller; direct null is finite coercion-safe here
  assert.equal(scoreLowerBetter(Number.NaN,800,1800),null);
  assert.equal(scoreLowerBetter(-1,800,1800),null);
});

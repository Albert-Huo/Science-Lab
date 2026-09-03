'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const expressRequire = createRequire(require.resolve('express/package.json'));
const bodyParserRequire = createRequire(expressRequire.resolve('body-parser/package.json'));

// Resolve each parent's actual dependency instead of assuming one hoisted qs copy.
for (const [parent, parentRequire] of [['express', expressRequire], ['body-parser', bodyParserRequire]]) {
  const qs = parentRequire('qs');

  test(`${parent}: comma bracket arrays obey arrayLimit`, () => {
    assert.throws(() => qs.parse('a[]=1,2,3,4', {
      comma: true,
      arrayLimit: 3,
      throwOnLimitExceeded: true,
    }), RangeError);
  });

  test(`${parent}: hostile constructor.isBuffer does not throw during a round-trip`, () => {
    const parsed = qs.parse('x[constructor][isBuffer]=y', { plainObjects: true });
    assert.doesNotThrow(() => qs.stringify(parsed));
  });

  test(`${parent}: ordinary query parsing and serialization are preserved`, () => {
    const expected = { topic: 'inertia', steps: ['1', '2'] };
    assert.deepEqual(qs.parse('topic=inertia&steps[]=1&steps[]=2'), expected);
    assert.deepEqual(qs.parse(qs.stringify(expected)), expected);
  });
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_MCP_HTTP_INPUT_ELEMENTS, isMcpHttpInputWithinLimit } from '../src/http-input-limit.js';

const LIMIT = 32_768;
const parsed = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// Helper-only admission tests: parser byte/depth constraints and HTTP dispatch
// remain covered separately by the frozen integration regression.
describe('MCP HTTP parsed-body element counter', () => {
  it('pins the approved cap independently of the exported constant', () => {
    assert.equal(MAX_MCP_HTTP_INPUT_ELEMENTS, LIMIT);
  });

  it('does not count scalar roots or characters within strings', () => {
    for (const value of [null, false, true, 0, -1.5, '', 'x'.repeat(LIMIT + 1)]) {
      assert.equal(isMcpHttpInputWithinLimit(parsed(value)), true);
    }
    assert.equal(isMcpHttpInputWithinLimit(parsed({ value: 'x'.repeat(LIMIT + 1) })), true);
  });

  it('does not count the root and accepts empty object and array roots', () => {
    assert.equal(isMcpHttpInputWithinLimit(JSON.parse('{}')), true);
    assert.equal(isMcpHttpInputWithinLimit(JSON.parse('[]')), true);
  });

  it('counts each array entry including null, with exact and over-cap boundaries', () => {
    for (const size of [LIMIT - 1, LIMIT, LIMIT + 1]) {
      assert.equal(isMcpHttpInputWithinLimit(parsed(Array(size).fill(null))), size <= LIMIT);
    }
  });

  it('counts own object members with exact and over-cap boundaries', () => {
    for (const size of [LIMIT - 1, LIMIT, LIMIT + 1]) {
      const value = Object.fromEntries(Array.from({ length: size }, (_, i) => [`key${i}`, null]));
      assert.equal(isMcpHttpInputWithinLimit(parsed(value)), size <= LIMIT);
    }
  });

  it('counts parsed own __proto__ subtrees despite a shadowed hasOwnProperty', () => {
    // JSON.parse creates an own __proto__ data member, unlike an object literal.
    // Two root members plus LIMIT - 2 entries is exactly the approved boundary.
    const body = JSON.parse('{"hasOwnProperty":null,"__proto__":[]}');
    body.__proto__ = Array(LIMIT - 2).fill(null);
    assert.equal(Object.prototype.hasOwnProperty.call(body, '__proto__'), true);
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), true);
    body.__proto__.push(null);
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), false);
  });

  it('ignores inherited enumerable members in an instrumentation-only prototype fixture', () => {
    // Custom prototypes are outside parsed JSON; this isolates the own-member filter.
    const body = Object.create({ inherited: Array(LIMIT + 1).fill(null) });
    body.own = null;
    assert.equal(isMcpHttpInputWithinLimit(body), true);
    body.own = Array(LIMIT).fill(null);
    assert.equal(isMcpHttpInputWithinLimit(body), false);
  });

  it('counts the edge to each empty container without counting its root again', () => {
    const body = Array.from({ length: LIMIT }, (_, i) => i % 2 ? {} : []);
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), true);
    body.push({});
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), false);
  });

  it('aggregates mixed sibling subtrees in one shared budget', () => {
    // Root batch entries (2), object members (2), child entries (LIMIT - 4).
    const body = [{ metadata: Array(LIMIT / 2 - 2).fill(null) },
      { arguments: Array(LIMIT / 2 - 2).fill(false) }];
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), true);
    body[1].arguments!.push(false);
    assert.equal(isMcpHttpInputWithinLimit(parsed(body)), false);
  });

  it('accepts exact-depth arrays and refuses the next edge without recursion', () => {
    for (const depth of [LIMIT, LIMIT + 1]) {
      const body = JSON.parse('['.repeat(depth) + 'null' + ']'.repeat(depth));
      assert.equal(isMcpHttpInputWithinLimit(body), depth === LIMIT);
    }
  });

  it('accepts exact-depth objects and refuses the next edge without recursion', () => {
    for (const depth of [LIMIT, LIMIT + 1]) {
      const body = JSON.parse('{"child":'.repeat(depth) + 'null' + '}'.repeat(depth));
      assert.equal(isMcpHttpInputWithinLimit(body), depth === LIMIT);
    }
  });

  it('visits only cap + 1 array entries and never descends into the refused child', () => {
    // Instrumentation fixture ONLY: proxies are not inputs from JSON.parse.
    // Observe explicit value reads, not V8 enumeration allocation or parser work.
    let reads = 0;
    let childReads = 0;
    const forbiddenChild = new Proxy([], {
      get() { childReads++; throw new Error('must not descend into refused edge'); },
    });
    const wide = new Proxy(Array(LIMIT + 100).fill(null), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads++;
          assert.ok(reads <= LIMIT + 1, 'must stop at first excess edge');
          if (Number(key) === LIMIT) return forbiddenChild;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    assert.equal(isMcpHttpInputWithinLimit(wide), false);
    assert.equal(reads, LIMIT + 1);
    assert.equal(childReads, 0);
  });

  it('does not read a later sibling after the first subtree exceeds the budget', () => {
    // Accessor fixture ONLY: the parsed-JSON contract excludes getters.
    let laterReads = 0;
    const body = { first: Array(LIMIT).fill(null), get later() {
      laterReads++;
      throw new Error('must not read sibling after rejection');
    } };
    assert.equal(isMcpHttpInputWithinLimit(body), false);
    assert.equal(laterReads, 0);
  });
});

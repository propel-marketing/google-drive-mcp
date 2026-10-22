/** HTTP-only admission budget, separate from Express's unchanged JSON byte limit.
 * Count every own object member and array entry in the parsed JSON body, including
 * envelope/metadata/batch entries. Strings are scalar values, not character arrays.
 * 32,768 admits a 1,000 x 26 Sheets grid (27,010 body elements); see docs/http-input-limit.md.
 */
export const MAX_MCP_HTTP_INPUT_ELEMENTS = 32_768;

function* children(value: object): Generator<unknown> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield value[i];
  } else {
    // No Object.values/entries or spread: do not materialize a hostile width.
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        yield (value as Record<string, unknown>)[key];
      }
    }
  }
}

/** For bodies produced by JSON.parse only (no getters, cycles or custom objects).
 * Iterative DFS avoids call-stack exhaustion. Visit at most limit+1 entries and
 * retain at most limit+1 iterators, rather than copying/flattening the whole body.
 */
export function isMcpHttpInputWithinLimit(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return true;
  const stack = [children(body)];
  let elements = 0;
  while (stack.length > 0) {
    const next = stack[stack.length - 1].next();
    if (next.done) {
      stack.pop();
      continue;
    }
    if (++elements > MAX_MCP_HTTP_INPUT_ELEMENTS) return false;
    if (next.value !== null && typeof next.value === 'object') {
      stack.push(children(next.value));
    }
  }
  return true;
}

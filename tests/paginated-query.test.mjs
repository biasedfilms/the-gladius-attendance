import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllRows } from "../js/paginated-query.js";

function mockQuery(rows, error = null, calls = []) {
  return () => ({
    async range(from, to) {
      calls.push([from, to]);
      if (error) return { data: null, error };
      return { data: rows.slice(from, to + 1), error: null };
    },
  });
}

test("fetches all records across multiple pages without truncation", async () => {
  const rows = Array.from({ length: 1203 }, (_, id) => ({ id }));
  const calls = [];
  const result = await fetchAllRows(mockQuery(rows, null, calls), 500);
  assert.equal(result.length, 1203);
  assert.deepEqual(result.map((row) => row.id), rows.map((row) => row.id));
  assert.deepEqual(calls, [[0, 499], [500, 999], [1000, 1499]]);
});

test("returns an empty array for an empty result", async () => {
  assert.deepEqual(await fetchAllRows(mockQuery([]), 100), []);
});

test("propagates query errors rather than hiding partial data", async () => {
  const error = new Error("permission denied");
  await assert.rejects(() => fetchAllRows(mockQuery([], error)), /permission denied/);
});

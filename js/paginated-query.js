/** Fetch a full Supabase result in stable, explicit pages instead of silently
 * stopping at the REST API's default maximum response size. */
export async function fetchAllRows(buildQuery, pageSize = 500) {
  if (typeof buildQuery !== "function") {
    throw new TypeError("buildQuery must be a function");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }

  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

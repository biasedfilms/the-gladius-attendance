/** PostgREST reports PGRST202 when an RPC does not exist (migration not applied). */
export const isMissingDatabaseFunction = (error) =>
  error?.code === "PGRST202" || /Could not find the function/i.test(String(error?.message || ""));

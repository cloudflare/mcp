/**
 * Storage isolation in vitest-pool-workers is per test FILE, not per test, so
 * real bindings like `OAUTH_KV` persist across tests within a file. Call this in
 * `afterEach` to wipe a namespace and restore per-test isolation.
 */
export async function clearKv(kv: KVNamespace): Promise<void> {
  const { keys } = await kv.list()
  await Promise.all(keys.map((k) => kv.delete(k.name)))
}

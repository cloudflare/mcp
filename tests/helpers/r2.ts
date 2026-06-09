/**
 * Storage isolation in vitest-pool-workers is per test FILE, not per test, so
 * a real R2 bucket binding persists across tests within a file. Call this in
 * `afterEach` to wipe a bucket and restore per-test isolation.
 */
export async function clearR2(bucket: R2Bucket): Promise<void> {
  const { objects } = await bucket.list()
  await Promise.all(objects.map((o) => bucket.delete(o.key)))
}

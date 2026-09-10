/**
 * Per-key write queue: sidecar read-modify-writes (pins, lineage, trash,
 * archive) must not interleave — a later write that read stale state would
 * silently drop the earlier change. Operations sharing a key run one after
 * another; different keys run in parallel. Failed operations still release
 * the queue, so one bad write cannot wedge the file.
 */
const tails = new Map<string, Promise<unknown>>();

export function enqueueWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = (tails.get(key) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  const result = previous.then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

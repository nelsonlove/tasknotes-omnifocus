// Stable, cycle-safe topological ordering for sequencing a sequential container's children by their
// blockedBy dependencies (#8). Pure; no I/O.

/**
 * Order `ids` so that each id's in-set dependencies (blockers) come before it. `depsFor(id)` returns the
 * ids that must precede `id`; dependencies pointing outside `ids` (or to self) are ignored — OmniFocus
 * can only sequence siblings within one container. Dependency-free ids and ties keep their original
 * relative order (stable). A dependency cycle is broken by emitting its remaining members in original
 * order; every input id appears exactly once in the output.
 */
export function orderByDeps(ids: string[], depsFor: (id: string) => string[]): string[] {
  const inSet = new Set(ids);
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // blocker -> ids it blocks
  for (const id of ids) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    const deps = [...new Set(depsFor(id).filter((d) => d !== id && inSet.has(d)))];
    indeg.set(id, deps.length);
    for (const d of deps) dependents.get(d)!.push(id);
  }

  const emitted: string[] = [];
  const done = new Set<string>();
  while (emitted.length < ids.length) {
    // Kahn's, made stable: take the earliest (original-order) not-yet-emitted id with no pending blockers.
    let picked: string | null = null;
    for (const id of ids) {
      if (!done.has(id) && (indeg.get(id) ?? 0) === 0) {
        picked = id;
        break;
      }
    }
    if (picked === null) {
      // Remaining ids form a cycle — emit them in original order rather than dropping any.
      for (const id of ids) if (!done.has(id)) {
        emitted.push(id);
        done.add(id);
      }
      break;
    }
    emitted.push(picked);
    done.add(picked);
    for (const dep of dependents.get(picked)!) indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
  }
  return emitted;
}

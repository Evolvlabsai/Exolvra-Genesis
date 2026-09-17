export interface Action<S> { name: string; next(state: S): readonly S[] }
export interface Invariant<S> { name: string; holds(state: S): boolean }
export interface Exploration<S> {
  init: readonly S[];
  actions: readonly Action<S>[];
  invariants: readonly Invariant<S>[];
  bounds: Record<string, number>;
  ceiling?: number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
/** Breadth first: the first violating path is a shortest counterexample. */
export function explore<S>(model: Exploration<S>) {
  const queue: { state: S; parent: number; action: string }[] = [];
  const seen = new Set<string>();
  const add = (state: S, parent: number, action: string): void => {
    const key = canonical(state);
    if (seen.has(key)) return;
    if (queue.length >= (model.ceiling ?? 100_000)) throw new Error('state ceiling exceeded; exploration is incomplete');
    seen.add(key); queue.push({ state, parent, action });
  };
  model.init.forEach((s) => add(s, -1, 'Init'));
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    for (const invariant of model.invariants) {
      if (!invariant.holds(node.state)) {
        const trace = [];
        for (let at = index; at >= 0; at = queue[at]!.parent) trace.unshift({ action: queue[at]!.action, state: queue[at]!.state });
        return { exhausted: false, states: queue.length, bounds: model.bounds, violation: invariant.name, trace };
      }
    }
    for (const action of model.actions) for (const next of action.next(node.state)) add(next, index, action.name);
  }
  return { exhausted: true, states: queue.length, bounds: model.bounds, violation: null, trace: [] };
}

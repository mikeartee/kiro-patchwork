// A small, dependency-free property-based-testing (PBT) layer for the Patchwork
// engine tests. The design's Testing Strategy mandates "a small in-repo
// generator layer (no external PBT dependency)"; this file is that layer's
// reusable core. It is deliberately generic so the three design properties can
// share it:
//   - Property 3 (this task, task 1.6): validate is deterministic + order-independent
//   - Property 2 (task 2.4):            gate never allows an undefined transition
//   - Property 1 (task 3.4):            verdict fails closed for all non-PASS inputs
//
// It provides exactly two things a property test needs:
//   1. `Rng` — a seeded, deterministic pseudo-random generator, so a failing
//      run is reproducible. Reproducibility matters: PBT failures are only
//      useful if you can replay the exact input that broke.
//   2. `forAll(iterations, genFn, propertyFn)` — runs a property over many
//      generated inputs and, on failure, augments the error with the iteration
//      index, the seed needed to reproduce it, and the failing input.
//
// The seed defaults to a fixed constant so CI runs are reproducible, and can be
// overridden with the PATCHWORK_PBT_SEED environment variable to explore a
// different input region or to replay a specific reported failure.

// A fixed default seed keeps ordinary runs reproducible. Override via the
// PATCHWORK_PBT_SEED env var (e.g. to replay a failing example's seed).
const DEFAULT_SEED = 0x5eed1234;

/**
 * Resolve the base seed for a run: PATCHWORK_PBT_SEED if it is a finite number,
 * otherwise the fixed default. Returned as an unsigned 32-bit integer.
 * @returns {number}
 */
export function defaultSeed() {
  const env = process.env.PATCHWORK_PBT_SEED;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return DEFAULT_SEED >>> 0;
}

// mulberry32: a compact, well-distributed 32-bit PRNG. Chosen over Math.random
// precisely because it is seedable and therefore reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// splitmix32 step: mixes a base seed and an iteration index into a fresh,
// well-scrambled per-iteration seed, so each iteration is independently
// reproducible from (baseSeed, i) without replaying the whole run.
function splitmix32(x) {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * A seeded, deterministic random source with the small set of helpers the
 * generators need. Constructed with an integer seed; identical seeds produce
 * identical sequences.
 */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }

  /** A float in [0, 1). */
  float() {
    return this._next();
  }

  /** An integer in [minInclusive, maxInclusive]. */
  int(minInclusive, maxInclusive) {
    if (maxInclusive < minInclusive) return minInclusive;
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(this._next() * span);
  }

  /** True with probability p (default 0.5). */
  bool(p = 0.5) {
    return this._next() < p;
  }

  /** A uniformly random element of a non-empty array. */
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  /** A shuffled copy of `arr` (Fisher-Yates); the input is not mutated. */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }
}

function safeStringify(value) {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    // Keep failure output readable even for large generated inputs.
    return s.length > 4000 ? `${s.slice(0, 4000)}… (truncated)` : s;
  } catch {
    return String(value);
  }
}

function augment(err, i, baseSeed, iterSeed, input) {
  const error = err instanceof Error ? err : new Error(String(err));
  const repro = [
    '',
    '--- property failed ---',
    `iteration: ${i}`,
    `reproduce with: PATCHWORK_PBT_SEED=${baseSeed} (per-iteration seed: ${iterSeed})`,
    `failing input: ${safeStringify(input)}`,
  ].join('\n');
  error.message = `${error.message}${repro}`;
  return error;
}

/**
 * Run a property over many generated inputs.
 *
 * @param {number} iterations
 *   How many inputs to test. Callers pass at least the required minimum
 *   (Property 3 requires >= 100).
 * @param {(rng: Rng) => any} genFn
 *   Produces one input from a seeded Rng. Called once per iteration with a
 *   fresh, deterministic Rng derived from (baseSeed, iterationIndex).
 * @param {(input: any) => (boolean|void)} propertyFn
 *   The property to check. It should either return `false` to signal failure,
 *   or throw (e.g. an assertion). Returning `true`/`undefined` means the
 *   property held for that input.
 * @param {{ seed?: number }} [options]
 *   Optional explicit base seed; defaults to `defaultSeed()`.
 *
 * On the first failing input this throws an error whose message carries the
 * iteration index, the seed to reproduce it, and the failing input.
 */
export function forAll(iterations, genFn, propertyFn, options = {}) {
  const baseSeed = (options.seed ?? defaultSeed()) >>> 0;
  const runs = Math.max(0, iterations | 0);

  for (let i = 0; i < runs; i++) {
    const iterSeed = splitmix32((baseSeed + i) | 0);
    const rng = new Rng(iterSeed);

    let input;
    try {
      input = genFn(rng);
    } catch (genErr) {
      const e = genErr instanceof Error ? genErr : new Error(String(genErr));
      e.message =
        `PBT generator threw at iteration ${i} ` +
        `(PATCHWORK_PBT_SEED=${baseSeed}, per-iteration seed: ${iterSeed}).\n${e.message}`;
      throw e;
    }

    let result;
    try {
      result = propertyFn(input);
    } catch (err) {
      throw augment(err, i, baseSeed, iterSeed, input);
    }

    if (result === false) {
      throw augment(
        new Error('property returned false'),
        i,
        baseSeed,
        iterSeed,
        input,
      );
    }
  }
}

/**
 * The budget guards: the two ways a run is allowed to stop itself.
 *
 * A guard is not a verdict. Tripping one says the run reached a limit the user
 * set, not that the work lost — so everything here produces a *reason to stop*
 * and a sentence naming which limit did it, and nothing here decides an exit
 * code or writes a line. The caller stops the session, records the run as
 * stopped, and reports it; this module only ever answers "has a limit been
 * reached, and which one".
 *
 * Cost is counted from what the provider itself reports and from nothing else.
 * The alternative — multiplying token counts by a price table kept in this CLI —
 * would stop runs on a number Anthropic never charged, and would go wrong
 * silently every time a price changed. A limit enforced against a made-up figure
 * is worse than no limit, because it looks like one.
 */
import { UsageError } from './exit.js';
import type { ValueType } from './registry.js';

/** Which limit stopped a run, spelled as the flag that set it. */
export type GuardName = 'max-rounds' | 'max-cost';

export interface BudgetLimits {
  /** Rounds to allow before stopping. Unset means no limit. */
  maxRounds?: number;
  /** US dollars to allow before stopping. Unset means no limit. */
  maxCostUsd?: number;
}

/** A limit that has been reached, and the line that says so. */
export interface BudgetTrip {
  guard: GuardName;
  /** One line, in this CLI's own words: which guard, and on what figures. */
  message: string;
}

/**
 * What a run has spent so far, and whether that is now too much.
 *
 * Both counters only ever go up, and a guard trips exactly once: the caller acts
 * on the first trip, and every call after it answers undefined so the same stop
 * is not reported twice.
 */
export interface Budget {
  /** Rounds judged so far. */
  readonly rounds: number;
  /** What the provider has reported this run costing so far, US dollars. */
  readonly costUsd: number;
  /** The trip that stopped the run, once one has. */
  readonly trip: BudgetTrip | undefined;
  /** Counts one judged round, and answers with the trip it caused. */
  countRound(): BudgetTrip | undefined;
  /** Adds what the provider reported, and answers with the trip it caused. */
  addCost(usd: number): BudgetTrip | undefined;
}

/**
 * An amount of money, written the way money is read.
 *
 * Two decimal places, because that is what a dollar figure has — except below a
 * cent, where two places would render every small run as `$0.00` and make a
 * cost limit look like it was never reached.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  return '$' + (amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2));
}

function plural(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

export function createBudget(limits: BudgetLimits = {}): Budget {
  let rounds = 0;
  let costUsd = 0;
  let trip: BudgetTrip | undefined;

  /** Records the first trip and answers with it; every later one answers with nothing. */
  const stop = (guard: GuardName, message: string): BudgetTrip | undefined => {
    if (trip !== undefined) return undefined;
    trip = { guard, message };
    return trip;
  };

  return {
    get rounds(): number {
      return rounds;
    },
    get costUsd(): number {
      return costUsd;
    },
    get trip(): BudgetTrip | undefined {
      return trip;
    },

    countRound(): BudgetTrip | undefined {
      rounds += 1;
      const limit = limits.maxRounds;
      if (limit === undefined || rounds < limit) return undefined;
      return stop(
        'max-rounds',
        'the --max-rounds guard stopped the run: ' +
          plural(rounds, 'round') +
          ' judged, and the limit is ' +
          limit,
      );
    },

    addCost(usd: number): BudgetTrip | undefined {
      // Anything that is not a positive, finite figure is not a cost. It is
      // ignored rather than added, so a provider that reports nothing for a turn
      // cannot turn the running total into NaN and disarm the guard entirely.
      if (Number.isFinite(usd) && usd > 0) costUsd += usd;
      const limit = limits.maxCostUsd;
      if (limit === undefined || costUsd < limit) return undefined;
      return stop(
        'max-cost',
        'the --max-cost guard stopped the run: ' +
          formatUsd(costUsd) +
          ' spent, and the limit is ' +
          formatUsd(limit),
      );
    },
  };
}

/**
 * The largest limit worth accepting, in dollars.
 *
 * Not a policy about what a run may cost — it is where a number stops being one
 * a person meant. Past this, a value is a typo or a paste, and accepting it
 * would arm a guard that can never fire while looking exactly like a guard that
 * can.
 */
const MAX_COST_LIMIT = 1_000_000;

/**
 * A cost limit in US dollars: a plain decimal amount, greater than zero.
 *
 * No currency sign and no thousands separator, because both are ways of writing
 * a number that this CLI would then have to guess the locale of. `1`, `2.50` and
 * `0.75` are amounts; `$5`, `5,00` and `1e3` are not, and each is refused by
 * name rather than quietly read as something else.
 */
export const costValue: ValueType<number> = {
  arg: 'usd',
  invalid: '0',
  parse(raw, ctx) {
    const text = raw.trim();
    const amount = Number(text);
    if (
      !/^\d+(\.\d{1,4})?$/.test(text) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_COST_LIMIT
    ) {
      throw new UsageError(
        [
          'invalid value "' +
            raw +
            '" for ' +
            ctx.flag +
            ': expected an amount in US dollars',
          '  a plain decimal above 0 and up to ' +
            MAX_COST_LIMIT +
            ', with up to 4 decimal places',
          '  no currency sign and no separators: 5, 2.50, 0.75',
        ].join('\n'),
        ctx.usage,
      );
    }
    return amount;
  },
};

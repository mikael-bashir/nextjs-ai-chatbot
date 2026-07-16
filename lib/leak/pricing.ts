// Placeholder pricing. The whole point of the worker/research phase is to
// gather historical run data (tokens, success rate, wall-clock per problem)
// and replace this with a data-backed model. For now every non-mock problem
// gets a single flat "standard" quote so the submit→prove→charge plumbing has
// a number to move through. Do NOT treat these figures as real margins.
//
// Reminder on the economics we are researching toward:
//   price(success) ≥ E[cost per attempt] / P(success) + margin
// because failed jobs are refunded, so successes must cover them.

export interface Quote {
  pricingClass: string;
  quotedCredits: number; // 1.0 credit = £1
}

export const DEFAULT_PRICING_CLASS = 'standard';
export const DEFAULT_QUOTE_CREDITS = 1.0;

// A canned, obviously-fake proof returned for mock submissions so a brand-new
// user can exercise the full API immediately after signup, before any real
// worker capacity exists.
export const MOCK_PROOF = [
  'theorem mock_problem : True := by',
  '  trivial',
].join('\n');

/**
 * Quote a problem. Placeholder heuristic — returns the flat standard price.
 * Later this will classify difficulty and price from historical data.
 */
export function quoteProblem(_problem: string): Quote {
  return {
    pricingClass: DEFAULT_PRICING_CLASS,
    quotedCredits: DEFAULT_QUOTE_CREDITS,
  };
}

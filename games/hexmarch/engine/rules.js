// Every tunable rule, with the value the game uses unless told otherwise.
// A game stores the full set it was played with, so records stay comparable
// and the balance lab can try variants without code changes.

export const RULES = {
  maxRounds: { default: 40, min: 1, max: 500,
    doc: 'Rounds before the game is decided by territory count.' },
  minIncome: { default: 3, min: 0, max: 20,
    doc: 'Fewest armies a player receives each round.' },
  territoriesPerArmy: { default: 3, min: 1, max: 12,
    doc: 'Territories needed for each army of income.' },
  islandBonus: { default: 1, min: 0, max: 4, fraction: true,
    doc: 'Multiplier on the bonus for holding a whole island.' },
  castleIncome: { default: 0, min: 0, max: 10,
    doc: 'Extra armies each round for every castle held, your own included.' },
  castleGarrison: { default: 5, min: 1, max: 30,
    doc: 'Armies a castle starts the game with.' },
  castleDefence: { default: 0, min: 0, max: 3,
    doc: "Added to the highest die of a player defending their own castle." },
  attackDice: { default: 3, min: 1, max: 3,
    doc: 'Most dice an attacking force rolls (also used in border clashes).' },
  defendDice: { default: 2, min: 1, max: 3,
    doc: 'Most dice a garrison rolls.' },
  clashTies: { default: 'both', options: ['both', 'none'],
    doc: 'In a border clash a tied pair of dice costs both sides an army, or neither.' },
  fallenLand: { default: 'neutral', options: ['neutral', 'captor'],
    doc: "A fallen player's other land turns neutral, or goes to whoever took the castle." },
  multiAttack: { default: 'largestFirst', options: ['largestFirst', 'smallestFirst'],
    doc: 'Which force fights first when several players attack one territory.' },
};

export const DEFAULT_RULES = Object.freeze(
  Object.fromEntries(Object.entries(RULES).map(([key, rule]) => [key, rule.default])),
);

// Fills in defaults and rejects anything that is not a known rule or value.
export function resolveRules(overrides = {}) {
  const rules = { ...DEFAULT_RULES };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const rule = RULES[key];
    if (!rule) throw new Error(`Unknown rule "${key}". Known rules: ${Object.keys(RULES).join(', ')}.`);
    const valid = rule.options
      ? rule.options.includes(value)
      : typeof value === 'number' && value >= rule.min && value <= rule.max && (rule.fraction || Number.isInteger(value));
    if (!valid) {
      const allowed = rule.options ? rule.options.join(' or ') : `${rule.fraction ? 'a number' : 'a whole number'} from ${rule.min} to ${rule.max}`;
      throw new Error(`Rule "${key}" must be ${allowed}; got ${JSON.stringify(value)}.`);
    }
    rules[key] = value;
  }
  return rules;
}

// Reads "key=value" text, as typed on a command line, into rule overrides.
export function parseRule(text) {
  const [key, raw] = String(text).split('=');
  if (!RULES[key] || raw === undefined) throw new Error(`Expected rule=value with a known rule, got "${text}".`);
  return [key, RULES[key].options ? raw : Number(raw)];
}

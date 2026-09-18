/**
 * The shape adapters read their credentials from.
 *
 * Deliberately looser than `NodeJS.ProcessEnv`: tests hand these factories a plain
 * object literal to prove that a missing credential produces `null` rather than a
 * half-configured adapter that fails on the first real call.
 */
export type EnvLike = Record<string, string | undefined>;

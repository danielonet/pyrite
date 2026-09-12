import { RuleBasedTranslator } from './rules/ruleTranslator';
import { Translator } from './types';

export * from './types';
export { translateWithRules } from './rules/ruleTranslator';

export type EngineName = 'rules';

export interface EngineConfig {
  engine: EngineName;
}

/**
 * Build the translator for the configured engine.
 *
 * There was a second, LLM-backed engine here; it was pulled out to keep
 * Pyrite offline and deterministic. See architecture/llm-engine.md for the
 * design if it needs to come back.
 */
export function createTranslator(_config: EngineConfig): { translator: Translator; note?: string } {
  return { translator: new RuleBasedTranslator() };
}

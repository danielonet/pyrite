import { RuleBasedTranslator } from './rules/ruleTranslator';
import { LlmOptions, LlmTranslator } from './llm/llmTranslator';
import { Translator } from './types';

export * from './types';
export { translateWithRules } from './rules/ruleTranslator';

export type EngineName = 'rules' | 'llm';

export interface EngineConfig {
  engine: EngineName;
  llm?: Partial<LlmOptions> & { apiKey?: string };
}

/**
 * Build the translator for the configured engine. Falls back to the rule
 * engine when the LLM engine is requested without an API key.
 */
export function createTranslator(config: EngineConfig): { translator: Translator; note?: string } {
  if (config.engine === 'llm') {
    const apiKey = config.llm?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        translator: new RuleBasedTranslator(),
        note: 'LLM engine selected but no API key is configured; using the rules engine. Run "Pyrite: Set LLM API Key" or set ANTHROPIC_API_KEY.',
      };
    }
    return {
      translator: new LlmTranslator({
        apiKey,
        model: config.llm?.model ?? 'claude-opus-5',
        effort: config.llm?.effort ?? 'medium',
        fallbackToRules: config.llm?.fallbackToRules ?? true,
        baseURL: config.llm?.baseURL,
      }),
    };
  }
  return { translator: new RuleBasedTranslator() };
}

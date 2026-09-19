import * as path from 'path';
import { DEFAULT_OLLAMA_OPTIONS, HybridTranslator, OllamaOptions } from './ollama/hybridTranslator';
import { RuleBasedTranslator } from './rules/ruleTranslator';
import { Translator } from './types';

export * from './types';
export { translateWithRules } from './rules/ruleTranslator';
export type { OllamaOptions } from './ollama/hybridTranslator';
export { DEFAULT_OLLAMA_OPTIONS } from './ollama/hybridTranslator';

/**
 *  - `rules`:  the deterministic, offline rules engine only.
 *  - `hybrid`: the rules engine, plus a local Ollama model for functions the rules handle badly.
 */
export type EngineName = 'rules' | 'hybrid';

export interface EngineConfig {
  engine: EngineName;
  /** Only used by the `hybrid` engine; unset fields take `DEFAULT_OLLAMA_OPTIONS`. */
  ollama?: Partial<OllamaOptions>;
}

/** Where the hybrid engine caches model answers for a project. */
export function ollamaCacheFile(root: string, outputFolder: string): string {
  return path.join(root, outputFolder, '.pyrite', 'ollama-cache.json');
}

/** Build the translator for the configured engine. */
export function createTranslator(config: EngineConfig): { translator: Translator; note?: string } {
  if (config.engine === 'hybrid') {
    return { translator: new HybridTranslator(new RuleBasedTranslator(), { ...DEFAULT_OLLAMA_OPTIONS, ...config.ollama }) };
  }
  return { translator: new RuleBasedTranslator() };
}

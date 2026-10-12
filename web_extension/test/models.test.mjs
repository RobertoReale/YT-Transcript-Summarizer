// Model ids go stale: providers retire them, and older versions of this
// extension froze their defaults into storage. A retired id only ever produces
// an API error, so it must be replaced — but a deliberate, still-valid choice
// must be left alone.
import { check, finish } from './harness.mjs';

const store = {};
globalThis.chrome = {
  storage: { local: {
    async get(keys) { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = structuredClone(store[k]); return o; },
    async set(obj) { Object.assign(store, structuredClone(obj)); },
  } },
};
const { PROVIDERS, resolveModel, migrateStoredModels } = await import('../modules/config.js');

// every default must be a non-retired model of its own provider
for (const [p, info] of Object.entries(PROVIDERS)) {
  if (!info.defaultModel) continue;
  check(`${p}: default is not itself retired`, resolveModel(p, info.defaultModel), info.defaultModel);
}

check('empty → default', resolveModel('gemini', ''), PROVIDERS.gemini.defaultModel);
check('shut-down gemini 2.0 → default', resolveModel('gemini', 'gemini-2.0-flash'), PROVIDERS.gemini.defaultModel);
check('shut-down gemini 1.5 → default', resolveModel('gemini', 'gemini-1.5-pro'), PROVIDERS.gemini.defaultModel);
check('retired groq llama → default', resolveModel('groq', 'llama-3.3-70b-versatile'), PROVIDERS.groq.defaultModel);
check('retired claude 3.x → default', resolveModel('anthropic', 'claude-3-7-sonnet-20250219'), PROVIDERS.anthropic.defaultModel);
check('retiring o1 → default', resolveModel('openai', 'o1'), PROVIDERS.openai.defaultModel);
check('a current claude is kept', resolveModel('anthropic', 'claude-opus-4-8'), 'claude-opus-4-8');
check('an unknown (newer) model is kept', resolveModel('openai', 'gpt-7-nova'), 'gpt-7-nova');
check('custom provider: anything goes', resolveModel('custom', 'llama3'), 'llama3');

// one-time migration of frozen old defaults
Object.assign(store, { models: {
  openai: 'gpt-4o', gemini: 'gemini-2.5-flash', groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-opus-4-8', custom: 'phi3',
} });
await migrateStoredModels();
check('old openai default migrated', store.models.openai, PROVIDERS.openai.defaultModel);
check('old gemini default migrated', store.models.gemini, PROVIDERS.gemini.defaultModel);
check('retired groq migrated', store.models.groq, PROVIDERS.groq.defaultModel);
check('valid claude choice untouched', store.models.anthropic, 'claude-opus-4-8');
check('custom untouched', store.models.custom, 'phi3');

// after the one-time pass, a deliberate gpt-4o choice is respected
store.models.openai = 'gpt-4o';
await migrateStoredModels();
check('second run leaves a deliberate old-default choice alone', store.models.openai, 'gpt-4o');

finish();

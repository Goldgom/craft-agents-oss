import type { Api, Model } from '@earendil-works/pi-ai';
import { isImageGenerationModelId } from '../../shared/src/config/llm-connections.ts';

/** Preserve connection order, never select a model from another credential scope. */
export function compactionModelCandidates<T extends Pick<Model<Api>, 'id' | 'name'>>(
  models: readonly T[], preferred?: string,
): T[] {
  const eligible = models.filter(model => !isImageGenerationModelId(model.id));
  const bare = preferred?.replace(/^pi\//, '').trim();
  const selected = eligible.find(model => model.id === bare || model.name === bare);
  const result = [
    ...(selected ? [selected] : []),
    ...eligible.filter(model => /luna/i.test(`${model.id} ${model.name}`)),
    ...eligible.filter(model => /haiku/i.test(`${model.id} ${model.name}`)),
    ...eligible.slice(-1),
  ];
  const seen = new Set<string>();
  return result.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

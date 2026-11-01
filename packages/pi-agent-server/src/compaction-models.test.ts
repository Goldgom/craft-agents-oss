import { describe, expect, it } from 'bun:test';
import { compactionModelCandidates } from './compaction-models.ts';

const models = [
  { id: 'main', name: 'Main' },
  { id: 'fast', name: 'LUNA Fast' },
  { id: 'claude-haiku', name: 'Haiku' },
  { id: 'gpt-luna', name: 'Luna' },
  { id: 'tail', name: 'Last' },
];
const ids = (preferred?: string, list = models) => compactionModelCandidates(list, preferred).map(model => model.id);
describe('connection compaction model priority', () => {
  it('honors an explicit preset strictly and uses priority only when no preset exists', () => {
    expect(ids('pi/main')).toEqual(['main']);
    expect(ids()).toEqual(['fast', 'gpt-luna', 'claude-haiku', 'tail']);
    expect(() => ids('missing')).toThrow('unavailable on this connection');
    expect(() => ids('gpt-image-1')).toThrow('unavailable on this connection');
    expect(ids('tail')).toEqual(['tail']);
  });
  it('falls back without inventing models and skips image-generation models', () => {
    expect(ids(undefined, models.filter(model => !/luna/i.test(model.id + model.name))))
      .toEqual(['claude-haiku', 'tail']);
    expect(ids(undefined, [models[0]!, models[4]!])).toEqual(['tail']);
    expect(ids(undefined, [models[0]!, { id: 'gpt-image-1', name: 'Image' }])).toEqual(['main']);
    expect(ids(undefined, [])).toEqual([]);
  });
  it('deduplicates a preferred luna model and leaves the original list intact', () => {
    const before = structuredClone(models);
    expect(ids('gpt-luna')).toEqual(['gpt-luna']);
    expect(models).toEqual(before);
  });
});

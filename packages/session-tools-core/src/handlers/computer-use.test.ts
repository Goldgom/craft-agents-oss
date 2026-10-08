import { describe, expect, it } from 'bun:test';
import { ComputerUseSchema, withToolImages } from '../computer-use.ts';
import { getSessionToolDefs, getToolDefsAsJsonSchema, SESSION_TOOL_REGISTRY } from '../tool-defs.ts';
import { handleComputerUse } from './computer-use.ts';
import type { SessionToolContext } from '../context.ts';

describe('computer_use', () => {
  it('rejects malformed input before launching the desktop component', async () => {
    const result = await handleComputerUse({} as SessionToolContext, { action: 'click', x: '1;calc' } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid computer_use arguments');
    expect(ComputerUseSchema.safeParse({ action: 'wait', durationMs: 6000 }).success).toBe(false);
    expect(ComputerUseSchema.safeParse({ action: 'focus', windowId: '-1' }).success).toBe(false);
    expect(ComputerUseSchema.safeParse({ action: 'click', x: -1200, y: -500 }).success).toBe(true);
  });

  it('uses one executable handler and advertises a structured schema on Windows', () => {
    expect(SESSION_TOOL_REGISTRY.get('computer_use')?.handler).toBe(handleComputerUse);
    expect(getSessionToolDefs().some(def => def.name === 'computer_use')).toBe(process.platform === 'win32');
    if (process.platform === 'win32') {
      const schema = getToolDefsAsJsonSchema().find(def => def.name === 'computer_use')!;
      expect(schema.inputSchema.required).toEqual(['action']);
      expect((schema.inputSchema.properties as any).action.enum).toContain('snapshot');
    }
  });

  it('preserves real images in the Pi result rather than turning them into text', () => {
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    expect(withToolImages({ content: 'coordinates', images: [image] })).toEqual([
      { type: 'text', text: 'coordinates' }, image,
    ]);
    expect(withToolImages({ content: 'error' })).toEqual([{ type: 'text', text: 'error' }]);
  });
});

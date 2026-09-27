import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleCanvasTool } from './canvas-tool.ts';

describe('canvas_tool', () => {
  it('passes a drawing operation to the desktop canvas capability', async () => {
    let received: Record<string, unknown> | undefined;
    const result = await handleCanvasTool({
      canvasToolFn: async args => { received = args; return { sessionId: 'drawing-1', selected: true }; },
    } as SessionToolContext, { action: 'select_session', sessionId: 'drawing-1' });
    expect(received).toEqual({ action: 'select_session', sessionId: 'drawing-1' });
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ sessionId: 'drawing-1', selected: true }, null, 2) });
  });

  it('reports when no desktop canvas is connected', async () => {
    const result = await handleCanvasTool({} as SessionToolContext, { action: 'list_sessions' });
    expect(result.isError).toBe(true);
  });
});

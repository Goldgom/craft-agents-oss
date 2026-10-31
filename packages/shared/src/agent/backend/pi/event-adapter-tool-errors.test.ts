import { expect, it } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

it('preserves the final timeout error when a shell streamed partial output', () => {
  const adapter = new PiEventAdapter();
  adapter.startTurn();
  [...adapter.adaptEvent({ type: 'tool_execution_start', toolCallId: 'slow', toolName: 'bash', args: { command: 'grep -r pattern .' } } as any)];
  [...adapter.adaptEvent({ type: 'tool_execution_update', toolCallId: 'slow', partialResult: { content: [{ type: 'text', text: 'partial match' }] } } as any)];
  const events = [...adapter.adaptEvent({
    type: 'tool_execution_end', toolCallId: 'slow', toolName: 'bash', isError: true,
    result: { content: [{ type: 'text', text: 'partial match\nCommand timed out after 15 seconds' }] },
  } as any)];
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'tool_result', isError: true });
  expect(JSON.stringify(events)).toContain('Command timed out after 15 seconds');
});

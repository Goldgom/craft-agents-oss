import { z } from 'zod';

export const ComputerUseSchema = z.object({
  action: z.enum(['status', 'screenshot', 'position', 'windows', 'snapshot', 'focus', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'wait']),
  x: z.number().int().optional().describe('Physical virtual-desktop X coordinate; may be negative'),
  y: z.number().int().optional().describe('Physical virtual-desktop Y coordinate; may be negative'),
  toX: z.number().int().optional(),
  toY: z.number().int().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.number().int().min(1).max(3).optional(),
  delta: z.number().int().min(-12000).max(12000).optional().describe('Wheel units: positive up, negative down; 120 per notch'),
  text: z.string().max(20000).optional().describe('Literal Unicode text to type, never a shell expression'),
  keys: z.string().min(1).max(200).optional().describe('Shortcut such as CTRL+L, ALT+TAB or ENTER'),
  windowId: z.string().regex(/^\d+$/).optional().describe('Window handle from windows; snapshot defaults to the foreground window'),
  durationMs: z.number().int().min(0).max(5000).optional(),
  maxWidth: z.number().int().min(320).max(4096).optional().describe('Screenshot width limit; default 1600. Use returned scale to map image pixels to physical desktop coordinates'),
  limit: z.number().int().min(1).max(300).optional().describe('Maximum windows or UI elements returned'),
});

export type ComputerUseArgs = z.infer<typeof ComputerUseSchema>;

export function isComputerUseTool(name: string): boolean {
  return name === 'computer_use' || name === 'mcp__session__computer_use';
}

export function isComputerUseReadOnly(input: Record<string, unknown>): boolean {
  return ['status', 'screenshot', 'position', 'windows', 'snapshot', 'wait'].includes(String(input.action));
}

export interface ToolImage {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Preserve actual image blocks across Claude, MCP and Pi transports. */
export function withToolImages(result: { content: string; images?: ToolImage[] }): Array<{ type: 'text'; text: string } | ToolImage> {
  return [{ type: 'text', text: result.content }, ...(result.images ?? [])];
}

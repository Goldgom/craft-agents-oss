import { z } from 'zod';

export const AGENT_PLUGIN_PROTOCOL_VERSION = 1;
const usage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(), cacheCreationTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(), contextWindow: z.number().positive().optional() });
const correlation = { turnId: z.string().optional() };
/** Only validated, supported events enter the host session stream. */
export const pluginEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string(), ...correlation }),
  z.object({ type: z.literal('text_complete'), text: z.string(), isIntermediate: z.boolean().optional(), ...correlation }),
  z.object({ type: z.literal('status'), message: z.string() }),
  z.object({ type: z.literal('info'), message: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('complete'), usage: usage.optional() }),
  z.object({ type: z.literal('tool_start'), toolName: z.string(), toolUseId: z.string(), input: z.record(z.string(), z.unknown()), ...correlation }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), toolName: z.string().optional(), result: z.string(), isError: z.boolean(), ...correlation }),
  z.object({ type: z.literal('usage_update'), usage: usage.pick({ inputTokens: true, contextWindow: true }) }),
]);

export interface PluginMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

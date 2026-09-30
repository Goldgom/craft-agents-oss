/**
 * Pool client for API sources.
 *
 * Connects to an in-process McpServer (created by createSdkMcpServer) via
 * in-memory transport, exposing it through the same PoolClient interface
 * that CraftMcpClient uses for remote MCP sources.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PoolCallToolOptions, PoolClient } from './client.ts';
import { withMcpRequestLifetime } from './request-lifetime.ts';

export class ApiSourcePoolClient implements PoolClient {
  private client: Client;
  private connected = false;
  private closed = false;
  private transport?: InMemoryTransport;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private mcpServer: McpServer) {
    this.client = new Client({ name: 'craft-pool-api-source', version: '1.0.0' });
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('API source client is closed');
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      // Own the pair before the first await so shutdown can cancel a handshake.
      this.transport = clientTransport;
      try {
        await this.mcpServer.connect(serverTransport);
        if (this.closed) throw new Error('API source client closed during connection');
        await this.client.connect(clientTransport);
        if (this.closed) throw new Error('API source client closed during connection');
        this.connected = true;
      } catch (error) {
        await this.close();
        throw error;
      }
    })();
    try { await this.connectPromise; } finally { this.connectPromise = undefined; }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown> {
    if (!this.connected) await this.connect();
    return withMcpRequestLifetime(signal => this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    }), options?.signal);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.connected = false;
    // Close only this wrapper's pair, once. Closing mcpServer itself (or closing
    // an old pair again) could tear down a newer wrapper using the same server.
    this.closePromise = this.transport?.close().catch(() => {}) ?? Promise.resolve();
    return this.closePromise;
  }
}

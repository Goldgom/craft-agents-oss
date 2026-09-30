/** UNRELEASED: excluded from ordinary test discovery while this disabled feature is blocked. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import NodeWebSocket from 'ws';
import { WsRpcServer, WsRpcClient, type RpcServer } from '@craft-agent/server-core/transport';
import { COLLABORATION_RELAY_RPC as C, COLLABORATION_RELAY_CAPABILITY, RPC_CHANNELS, PROTOCOL_VERSION, type CollaborationRelayDelivery as Delivery, type CollaborationRelayReceipt as Receipt, type Session, type CollaborationRelayCreateInput, type CollaborationServerRef } from '@craft-agent/shared/protocol';
import type { HandlerDeps } from '@craft-agent/server-core/handlers';
import { registerCollaborationRelayHandlers } from '@craft-agent/server-core/handlers/rpc/collaboration-relay';
import { RelayParticipantManager } from '../../../../../packages/server-core/src/collaboration/RelayParticipantManager';
import { CollaborationRelayManager, validateRelayUrl, type CollaborationRelayDependencies } from '../collaboration/CollaborationRelayManager';
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse())
        await close();
});
const pause = () => Bun.sleep(25);
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'collaboration-mixed-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const servers: Awaited<ReturnType<typeof host>>[] = [];
    async function host(name: string) {
        const path = join(root, name), workspaceId = 'same-workspace', token = `owned-dummy-${name}-token`;
        const sessions = new Map<string, Session>();
        for (const id of ['primary-session', 'same-session'])
            sessions.set(id, { id, workspaceId, workspaceName: name, name: id, isProcessing: false, lastMessageAt: 0, messages: [{ id: 'goal', role: 'user', content: 'Only the selected collaboration task', timestamp: 1 }] });
        let created = 0;
        const accepted: Delivery[] = [], deletes: string[] = [];
        const deps = {
            getSession: async (id: string) => sessions.get(id) ?? null,
            getSessions: () => [...sessions.values()],
            createSession: async (_ws: string, options?: {
                name?: string;
            }, internal?: any) => { const s: Session = { id: `new-${++created}`, workspaceId, workspaceName: name, name: options?.name ?? 'Fresh', isProcessing: false, lastMessageAt: 0, messages: [], collaboration: internal?.collaboration }; sessions.set(s.id, s); return s; },
            deleteSession: async (id: string) => { deletes.push(id); sessions.delete(id); },
            setSessionCollaboration: async (id: string, value: any) => {
                const s = sessions.get(id)!;
                if (value && s.collaboration && s.collaboration.groupId !== value.groupId)
                    throw new Error('Already reserved');
                s.collaboration = value ?? undefined;
            },
            acceptCollaborationRelayMessage: async (id: string, delivery: Delivery): Promise<Receipt> => {
                const s = sessions.get(id)!;
                const existing = accepted.find(d => d.groupId === delivery.groupId && d.sequence === delivery.sequence && d.targetMemberId === delivery.targetMemberId);
                if (!existing) {
                    accepted.push(structuredClone(delivery));
                    s.messages.push({ id: `delivery-${delivery.targetMemberId}-${delivery.sequence}`, role: 'user', content: delivery.message, timestamp: Date.now() });
                }
                return { operationId: delivery.operationId, sequence: delivery.sequence, messageId: `delivery-${delivery.targetMemberId}-${delivery.sequence}`, delivery: 'queued', targetBusy: false };
            },
        };
        const manager = new RelayParticipantManager({ sessions: deps, workspaceRoot: id => {
                if (id !== workspaceId)
                    throw new Error('No workspace');
                return path;
            }, stateRoot: path });
        const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async (value) => value === token });
        const hooks = { failAfter: undefined as string | undefined, failBefore: undefined as string | undefined, legacy: false, after: undefined as ((channel: string) => void) | undefined };
        const proxy: RpcServer = {
            handle: (channel, handler) => server.handle(channel, async (ctx, input) => {
                if (hooks.failBefore === channel)
                    throw new Error('Dummy outage');
                const result = await handler(ctx, input);
                hooks.after?.(channel);
                if (hooks.failAfter === channel) {
                    hooks.failAfter = undefined;
                    throw new Error('Owned response lost after commit');
                }
                ;
                if (hooks.legacy && channel === C.INFO)
                    return { protocolVersion: 0 };
                return result;
            }),
            push: server.push.bind(server), invokeClient: server.invokeClient.bind(server), hasClientCapability: server.hasClientCapability.bind(server), findClientsWithCapability: server.findClientsWithCapability.bind(server),
        };
        registerCollaborationRelayHandlers(proxy, { sessionManager: { ...deps, getCollaborationRelayManager: () => manager } } as unknown as HandlerDeps);
        server.handle(RPC_CHANNELS.server.GET_WORKSPACES, () => [{ id: workspaceId, name }]);
        server.handle(RPC_CHANNELS.collaborations.LIST_CANDIDATES, ctx => {
            if (ctx.workspaceId !== workspaceId)
                throw new Error('Wrong workspace');
            return [...sessions.values()];
        });
        await server.listen();
        cleanups.push(async () => { await server.close(); await manager.cleanup(); });
        return { reopenManager: () => { const reopened = new RelayParticipantManager({ sessions: deps, workspaceRoot: () => path, stateRoot: path }); cleanups.push(() => reopened.cleanup()); return reopened; }, name, path, workspaceId, token, url: `ws://127.0.0.1:${server.port}`, sessions, manager, server, hooks, accepted, deletes, created: () => created };
    }
    const local = await host('local'), peer = await host('peer'), third = await host('third');
    servers.push(local, peer, third);
    let generation = 0;
    const revisions = new Map([['local', 1], ['peer', 1], ['third', 1]]);
    const refs = { local: { kind: 'local' } as const, peer: { kind: 'saved', profileId: 'peer' } as const, third: { kind: 'saved', profileId: 'third' } as const };
    let nativeServer: CollaborationServerRef = refs.local;
    const resolutions: string[] = [];
    const deps: CollaborationRelayDependencies = {
        stateDirectory: join(root, 'main'),
        getWindowBinding: event => {
            if (event !== 'trusted-native-event')
                throw new Error('Untrusted sender');
            return { senderId: 7, generation, server: nativeServer, serverWorkspaceId: local.workspaceId, serverName: 'Local', workspaceName: 'Workspace' };
        },
        listServers: async () => Object.entries(refs).map(([name, server]) => ({ server, name, credentialAvailable: true })),
        resolveServer: async (ref) => {
            const name = ref.kind === 'local' ? 'local' : ref.profileId;
            resolutions.push(name);
            const s = servers.find(s => s.name === name);
            if (!s)
                throw new Error('Unknown saved profile');
            return { url: s.url, token: s.token, revision: revisions.get(name)!, name };
        },
    };
    let relay = new CollaborationRelayManager(deps);
    cleanups.push(() => relay.close());
    const input = async (): Promise<CollaborationRelayCreateInput> => ({ contextId: (await relay.setup('trusted-native-event', 'primary-session')).contextId, operationId: randomUUID(), secondaries: [{ server: refs.peer, workspaceId: peer.workspaceId, sessionId: 'same-session' }, { server: refs.third, workspaceId: third.workspaceId, createNew: true, name: 'Fresh peer' }] });
    const restart = async () => { await relay.close(); await pause(); relay = new CollaborationRelayManager(deps); await relay.tick(); return relay; };
    return { root, local, peer, third, refs, deps, revisions, resolutions, input, restart, relay: () => relay, changeWindow: () => generation++, selectNativeServer: (server: CollaborationServerRef) => { nativeServer = server; generation++; } };
}
test('one real authenticated group keeps local primary and peers on two servers; request/report/board/file route by member', async () => {
    const f = await fixture(), input = await f.input(), result = await f.relay().create('trusted-native-event', input);
    expect(result.state).toBe('active');
    expect(result.activationStatus).toBe('started');
    expect(f.third.created()).toBe(1);
    expect(f.local.created()).toBe(0);
    const localMembership = f.local.sessions.get('primary-session')!.collaboration!;
    expect(localMembership.groupId).toBe(result.groupId);
    expect(f.peer.sessions.get('same-session')!.collaboration?.groupId).toBe(result.groupId);
    expect(f.third.sessions.get('new-1')!.collaboration?.groupId).toBe(result.groupId);
    expect(f.peer.sessions.get('primary-session')!.collaboration).toBeUndefined();
    await f.local.manager.perform('primary-session', { kind: 'message', targetMemberId: 'secondary_1', message: 'Bounded task for peer one' });
    await f.relay().tick();
    expect(f.peer.accepted).toHaveLength(1);
    expect(f.third.accepted).toHaveLength(0);
    await f.peer.manager.perform('same-session', { kind: 'board', itemId: 'task.secondary_1', value: { status: 'done', evidence: 'dummy verification' } });
    await f.peer.manager.perform('same-session', { kind: 'message', targetMemberId: 'primary', message: 'Verified peer report' });
    await f.relay().tick();
    expect(f.local.accepted).toHaveLength(2);
    expect(f.local.accepted[1]!.message).toContain('Verified peer report');
    const group: any = await f.third.manager.readForSession('new-1');
    expect(group.members).toHaveLength(3);
    expect(new Set(group.members.map((m: any) => m.serverId)).size).toBe(3);
    expect(group.board['task.secondary_1'].value.status).toBe('done');
    const shared: any = await f.peer.manager.perform('same-session', { kind: 'putFile', name: 'result.txt', dataBase64: Buffer.from('owned dummy content').toString('base64') });
    const downloaded: any = await f.third.manager.readForSession('new-1', shared.file.id);
    expect(Buffer.from(downloaded.dataBase64, 'base64').toString()).toBe('owned dummy content');
    const journal = await readFile(join(f.root, 'main', `${input.operationId}.json`), 'utf8');
    expect(journal).not.toContain(f.peer.token);
    expect(journal).not.toContain(f.third.token);
    expect(journal).not.toContain('token"');
    await expect(f.relay().setup('forged-websocket-window', 'primary-session')).rejects.toThrow('Untrusted sender');
    f.changeWindow();
    await expect(f.relay().create('trusted-native-event', input)).rejects.toThrow('context expired');
}, 15000);
test('creation retry and main restart recover the same group and do not create new sessions', async () => {
    const f = await fixture(), input = await f.input();
    const [a, b] = await Promise.all([f.relay().create('trusted-native-event', input), f.relay().create('trusted-native-event', input)]);
    expect(a.groupId).toBe(b.groupId);
    expect(f.third.created()).toBe(1);
    const restarted = await f.restart();
    const setup = await restarted.setup('trusted-native-event', 'primary-session');
    expect(setup.pendingCreations.map(j => j.operationId)).toEqual([input.operationId]);
    expect((await restarted.status('trusted-native-event', { operationId: input.operationId })).state).toBe('active');
    const recovered = await restarted.create('trusted-native-event', { ...input, contextId: setup.contextId });
    expect(recovered.groupId).toBe(a.groupId);
    expect(f.third.created()).toBe(1);
}, 15000);
test('lost prepare reply rolls back only its newly created session; old chats remain', async () => {
    const f = await fixture(), input = await f.input();
    f.third.hooks.failAfter = C.PREPARE;
    const result = await f.relay().create('trusted-native-event', input);
    expect(result.state).toBe('aborted');
    expect(f.third.created()).toBe(1);
    expect(f.third.deletes).toEqual(['new-1']);
    expect(f.local.sessions.has('primary-session')).toBe(true);
    expect(f.peer.sessions.has('same-session')).toBe(true);
    expect(f.local.sessions.get('primary-session')!.collaboration).toBeUndefined();
    expect(f.peer.sessions.get('same-session')!.collaboration).toBeUndefined();
}, 15000);
test('lost commit reply rolls forward once after reconnect; never replays primary activation', async () => {
    const f = await fixture(), input = await f.input();
    f.third.hooks.failAfter = C.COMMIT;
    const partial = await f.relay().create('trusted-native-event', input);
    expect(partial.state).toBe('committing');
    await pause();
    await f.relay().tick();
    expect((await f.relay().status('trusted-native-event', { operationId: input.operationId })).state).toBe('active');
    expect(f.third.created()).toBe(1);
    expect(f.local.accepted.filter(d => d.operationId === 'activation')).toHaveLength(1);
}, 15000);
test('lost delivery ACK and restarted receiver retain at-most-one message acceptance', async () => {
    const f = await fixture(), result = await f.relay().create('trusted-native-event', await f.input());
    expect(result.state).toBe('active');
    f.peer.hooks.failAfter = C.ACCEPT;
    await f.local.manager.perform('primary-session', { kind: 'message', targetMemberId: 'secondary_1', message: 'One task despite response loss' });
    await f.relay().tick();
    expect(f.peer.accepted).toHaveLength(1);
    const reopened = f.peer.reopenManager();
    const receipt = await reopened.accept(f.peer.workspaceId, f.peer.accepted[0]!);
    expect(receipt.operationId).toBe(f.peer.accepted[0]!.operationId);
    expect(f.peer.accepted).toHaveLength(1);
    await pause();
    await f.relay().tick();
    await f.relay().tick();
    expect(f.peer.accepted).toHaveLength(1);
    const old = f.peer.accepted[0]!;
    await expect(f.peer.manager.accept(f.peer.workspaceId, old)).rejects.toThrow('already retired');
    expect(f.peer.accepted).toHaveLength(1);
}, 15000);
test('unapproved origin/member and arbitrary endpoint requests cannot choose another saved credential', async () => {
    const f = await fixture();
    const result = await f.relay().create('trusted-native-event', await f.input());
    const m = f.peer.sessions.get('same-session')!.collaboration!;
    const clientId = f.peer.server.findClientsWithCapability(COLLABORATION_RELAY_CAPABILITY, { workspaceId: f.peer.workspaceId })[0]!;
    const before = f.resolutions.length;
    await expect(f.peer.server.invokeClient(clientId, COLLABORATION_RELAY_CAPABILITY, { kind: 'operation', operation: { groupId: result.groupId, epoch: m.relay!.epoch, ownerId: m.relay!.ownerId, memberId: 'primary', operationId: randomUUID(), sequence: 1, input: { kind: 'message', targetMemberId: 'secondary_2', message: 'forged origin', serverUrl: 'https://evil.invalid', profileId: 'unapproved' } } })).rejects.toThrow();
    expect(f.resolutions.slice(before)).not.toContain('unapproved');
    expect(f.third.accepted).toHaveLength(0);
}, 15000);
test('missing protocol rejects before side effects; strict TLS rejects non-loopback WS and URL credentials', async () => {
    const f = await fixture(), input = await f.input();
    f.third.hooks.legacy = true;
    expect((await f.relay().create('trusted-native-event', input)).state).toBe('aborted');
    expect(f.third.created()).toBe(0);
    expect(f.local.sessions.get('primary-session')!.collaboration).toBeUndefined();
    expect(() => validateRelayUrl('ws://remote.example:9000')).toThrow();
    expect(() => validateRelayUrl('wss://user:password@example.com')).toThrow();
    expect(() => validateRelayUrl('wss://example.com?token=dummy')).toThrow();
    expect(validateRelayUrl('wss://example.com')).toBe('wss://example.com');
}, 15000);
test('saved profile generation change pauses without silently retargeting and offline end remains truthful', async () => {
    const f = await fixture(), input = await f.input(), result = await f.relay().create('trusted-native-event', input);
    f.revisions.set('peer', 2);
    await f.relay().tick();
    expect((await f.relay().status('trusted-native-event', { groupId: result.groupId })).state).toBe('paused');
    const setup = await f.relay().setup('trusted-native-event', 'primary-session');
    await pause();
    expect((await f.relay().create('trusted-native-event', { ...input, contextId: setup.contextId })).state).toBe('active');
    f.peer.hooks.failBefore = C.END;
    const ended = await f.relay().end('trusted-native-event', { operationId: input.operationId });
    expect(ended.state).toBe('ended');
    expect(ended.warnings?.[0]?.code).toBe('END_PENDING');
    f.peer.hooks.failBefore = undefined;
    await pause();
    await f.relay().tick();
    expect(f.peer.sessions.get('same-session')!.collaboration).toBeUndefined();
    expect(f.local.sessions.get('primary-session')!.collaboration).toBeUndefined();
    expect(f.third.sessions.has('new-1')).toBe(true);
}, 15000);
test('relay RPC rejects unauthenticated provenance even if a caller claims a window and capability', async () => {
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => server.close());
    registerCollaborationRelayHandlers(server, {} as HandlerDeps);
    await server.listen();
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { webContentsId: 7, workspaceId: 'same-workspace', clientCapabilities: [COLLABORATION_RELAY_CAPABILITY], autoReconnect: false });
    cleanups.push(() => client.destroy());
    await expect(client.invoke(C.INFO, { authenticatedBy: 'bearer' })).rejects.toThrow('relay request rejected');
});
test('strict main relay rejects a real self-signed WSS certificate before authenticating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-owned-tls-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const key = join(root, 'owned-key.pem'), cert = join(root, 'owned-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    let authAttempts = 0, rpcAttempts = 0;
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async () => { authAttempts++; return true; }, tls: { key: await readFile(key), cert: await readFile(cert) } });
    server.handle(C.INFO, () => { rpcAttempts++; return {}; });
    await server.listen();
    cleanups.push(() => server.close());
    const relay = new CollaborationRelayManager({ stateDirectory: join(root, 'main'), getWindowBinding: () => ({ senderId: 1, generation: 1, server: { kind: 'local' }, serverWorkspaceId: 'workspace', serverName: 'Owned TLS', workspaceName: 'Owned' }), listServers: async () => [], resolveServer: async () => ({ url: `wss://127.0.0.1:${server.port}`, token: 'owned-dummy-tls-token', revision: 1, name: 'Owned TLS' }) });
    cleanups.push(() => relay.close());
    await expect(relay.setup('native', 'primary')).rejects.toThrow('unavailable');
    expect(authAttempts).toBe(0);
    expect(rpcAttempts).toBe(0);
}, 15000);
test('receipt retirement is sequence-fenced across restart and never reaccepts an old delivery', async () => {
    const f = await fixture(), created = await f.relay().create('trusted-native-event', await f.input());
    expect(created.state).toBe('active');
    const c = f.peer.sessions.get('same-session')!.collaboration!;
    const make = (sequence: number): Delivery => {
        const value = { groupId: created.groupId, epoch: c.relay!.epoch, ownerId: c.relay!.ownerId, operationId: `bounded-${sequence}`, sequence, sourceMemberId: 'primary', targetMemberId: 'secondary_1', target: { serverId: c.relay!.serverId, workspaceId: f.peer.workspaceId, sessionId: 'same-session' }, message: `Dummy ${sequence}` };
        return { ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
    };
    for (let sequence = 1; sequence <= 256; sequence++)
        await f.peer.manager.accept(f.peer.workspaceId, make(sequence));
    await expect(f.peer.manager.accept(f.peer.workspaceId, make(257))).rejects.toThrow('capacity');
    await f.peer.manager.acknowledge(f.peer.workspaceId, { groupId: created.groupId, epoch: c.relay!.epoch, ownerId: c.relay!.ownerId }, { kind: 'retireDeliveries', memberId: 'secondary_1', sequence: 128 });
    const reopened = f.peer.reopenManager();
    await expect(reopened.accept(f.peer.workspaceId, make(1))).rejects.toThrow('already retired');
    expect((await reopened.accept(f.peer.workspaceId, make(257))).sequence).toBe(257);
    const record = JSON.parse(await readFile(join(f.peer.path, '.tokenbird', 'collaboration-relay', `${created.groupId}.json`), 'utf8'));
    expect(record.inbox.secondary_1.retired).toBe(128);
    expect(Object.keys(record.inbox.secondary_1.receipts)).toHaveLength(129);
    expect(f.peer.accepted).toHaveLength(257);
}, 15000);
test('remote primary and local peer with identical bare session IDs remain distinct members', async () => {
    const f = await fixture();
    f.selectNativeServer(f.refs.peer);
    const setup = await f.relay().setup('trusted-native-event', 'primary-session');
    expect(setup.primary.server).toEqual(f.refs.peer);
    const result = await f.relay().create('trusted-native-event', { contextId: setup.contextId, operationId: randomUUID(), secondaries: [{ server: f.refs.local, workspaceId: f.local.workspaceId, sessionId: 'primary-session' }] });
    expect(result.state).toBe('active');
    expect(f.peer.accepted).toHaveLength(1);
    await f.peer.manager.perform('primary-session', { kind: 'message', targetMemberId: 'secondary_1', message: 'Same ID, different server' });
    await f.relay().tick();
    expect(f.local.accepted).toHaveLength(1);
    expect(f.local.accepted[0]!.message).toContain('Same ID, different server');
    f.selectNativeServer(f.refs.local);
    expect((await f.relay().list('trusted-native-event'))[0]!.canEnd).toBe(false);
    await expect(f.relay().end('trusted-native-event', { groupId: result.groupId })).rejects.toThrow('authority');
}, 15000);
test('invalid secondary actions do not poison its durable operation sequence', async () => {
    const f = await fixture();
    await f.relay().create('trusted-native-event', await f.input());
    await expect(f.peer.manager.perform('same-session', { kind: 'board', itemId: 'goal.current', value: 'not allowed' })).rejects.toThrow('own task');
    await expect(f.peer.manager.perform('same-session', { kind: 'message', targetMemberId: 'secondary_2', message: 'not allowed' })).rejects.toThrow('cannot message');
    await f.peer.manager.perform('same-session', { kind: 'message', targetMemberId: 'primary', message: 'Valid report after validation errors' });
    await f.relay().tick();
    expect(f.local.accepted).toHaveLength(2);
    expect(f.local.accepted[1]!.message).toContain('Valid report');
}, 15000);
test('rollback retains a newly created chat that the user changed', async () => {
    const f = await fixture(), input = await f.input();
    f.third.hooks.after = channel => {
        if (channel === C.PREPARE)
            f.third.sessions.get('new-1')!.name = 'User renamed this chat';
    };
    f.third.hooks.failAfter = C.PREPARE;
    const result = await f.relay().create('trusted-native-event', input);
    expect(result.state).toBe('aborted');
    expect(f.third.deletes).toEqual([]);
    expect(f.third.sessions.get('new-1')!.name).toBe('User renamed this chat');
    expect(f.third.sessions.get('new-1')!.collaboration).toBeUndefined();
    expect(result.warnings?.some(w => w.code === 'CREATED_CHAT_RETAINED')).toBe(true);
}, 15000);
test('offline Electron queues reports durably and restart forwards only that pending report', async () => {
    const f = await fixture(), result = await f.relay().create('trusted-native-event', await f.input());
    await f.relay().close();
    await pause();
    const report: any = await f.peer.manager.perform('same-session', { kind: 'message', targetMemberId: 'primary', message: 'Completed while the desktop was offline' });
    expect(report.delivery).toBe('queued-for-relay');
    expect(f.local.accepted).toHaveLength(1);
    await f.restart();
    expect(f.local.accepted).toHaveLength(2);
    expect(f.local.accepted[1]!.message).toContain('offline');
    expect((await f.relay().status('trusted-native-event', { groupId: result.groupId })).requiresRunningDesktop).toBe(true);
}, 15000);
test('two main services share the creation journal while only one live relay connection owns delivery', async () => {
    const f = await fixture(), input = await f.input();
    const second = new CollaborationRelayManager(f.deps);
    cleanups.push(() => second.close());
    const secondContext = await second.setup('trusted-native-event', 'primary-session');
    const [a, b] = await Promise.all([f.relay().create('trusted-native-event', input), second.create('trusted-native-event', { ...input, contextId: secondContext.contextId })]);
    expect(a.groupId).toBe(b.groupId);
    expect(f.third.created()).toBe(1);
    expect(f.local.accepted.filter(d => d.operationId === 'activation')).toHaveLength(1);
    await second.close();
    await f.relay().tick();
    expect(f.local.accepted.filter(d => d.operationId === 'activation')).toHaveLength(1);
}, 15000);
test('cookie authentication cannot resume a bearer-authenticated relay client identity', async () => {
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async (t) => t === 'dummy-bearer', validateSessionCookie: async (c) => c === 'owned-cookie=yes' });
    cleanups.push(() => server.close());
    await server.listen();
    const open = async (cookie: boolean, reconnectClientId?: string) => {
        const ws = new NodeWebSocket(`ws://127.0.0.1:${server.port}`, cookie ? { headers: { Cookie: 'owned-cookie=yes' } } : undefined);
        cleanups.push(() => ws.terminate());
        const ack = await new Promise<any>((resolve, reject) => {
            ws.on('error', reject);
            ws.on('message', bytes => {
                const msg = JSON.parse(bytes.toString());
                if (msg.type === 'handshake_ack')
                    resolve(msg);
                if (msg.type === 'error')
                    reject(new Error(msg.error?.message));
            });
            ws.on('open', () => ws.send(JSON.stringify({ id: randomUUID(), type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: 'workspace', webContentsId: 7, token: cookie ? undefined : 'dummy-bearer', clientCapabilities: [COLLABORATION_RELAY_CAPABILITY], authenticatedBy: 'bearer', ...(reconnectClientId ? { reconnectClientId, lastSeq: 0 } : {}) })));
        });
        return { ws, ack };
    };
    const bearer = await open(false), oldId = bearer.ack.clientId;
    await new Promise<void>(resolve => { bearer.ws.once('close', () => resolve()); bearer.ws.close(); });
    await pause();
    const cookie = await open(true, oldId);
    expect(cookie.ack.clientId).not.toBe(oldId);
});
test('asynchronous native binding is revalidated after discovery and cannot create a stale context', async () => {
    const f = await fixture(), original = f.deps.getWindowBinding;
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.deps.getWindowBinding = async (event) => { const b = await original(event); entered(); await gate; return b; };
    const setup = f.relay().setup('trusted-native-event', 'primary-session');
    void setup.catch(() => { });
    await arrived;
    f.changeWindow();
    release();
    await expect(setup).rejects.toThrow('binding changed');
    expect((f.relay() as any).contexts.size).toBe(0);
});
test('shutdown destroys an in-flight discovery client and cannot publish or revive it later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-closing-discovery-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let created!: () => void, reject!: (error: Error) => void, closes = 0;
    const started = new Promise<void>(resolve => { created = resolve; });
    const manager = new CollaborationRelayManager({ stateDirectory: root, getWindowBinding: () => ({ senderId: 1, generation: 1, server: { kind: 'local' }, serverWorkspaceId: 'workspace', serverName: 'Local', workspaceName: 'Workspace' }), listServers: async () => [], resolveServer: async () => ({ url: 'ws://127.0.0.1:1', token: 'owned-dummy', revision: 1, name: 'Local' }), createClient: () => { created(); return { invoke: () => new Promise((_resolve, no) => { reject = no; }), handleCapability: () => { }, destroy: () => { closes++; reject?.(new Error('Owned shutdown')); } }; } });
    cleanups.push(() => manager.close());
    const pending = manager.setup('native', 'primary');
    void pending.catch(() => { });
    await started;
    await manager.close();
    await expect(pending).rejects.toThrow('unavailable');
    expect(closes).toBeGreaterThanOrEqual(1);
    expect((manager as any).connections.size).toBe(0);
    expect((manager as any).pendingClients.size).toBe(0);
});
test('relay callback never transmits a local credential resolver error to a remote peer', async () => {
    const f = await fixture();
    const result = await f.relay().create('trusted-native-event', await f.input());
    const member = f.peer.sessions.get('same-session')!.collaboration!;
    const clientId = f.peer.server.findClientsWithCapability(COLLABORATION_RELAY_CAPABILITY, { workspaceId: f.peer.workspaceId })[0]!;
    const resolve = f.deps.resolveServer;
    f.deps.resolveServer = async (ref) => { if (ref.kind === 'local')
        throw new Error('dummy-local-vault-secret-marker'); return resolve(ref); };
    const error = await f.peer.server.invokeClient(clientId, COLLABORATION_RELAY_CAPABILITY, { kind: 'read', groupId: result.groupId, epoch: member.relay!.epoch, ownerId: member.relay!.ownerId, memberId: 'secondary_1' }).then(() => undefined, error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain('dummy-local-vault-secret-marker');
    expect(error?.message).toContain('forwarding is unavailable');
});

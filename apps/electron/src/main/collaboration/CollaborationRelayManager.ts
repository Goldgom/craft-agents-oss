/** Electron-main only relay. Saved credentials never enter persisted routes or DTOs. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WsRpcClient } from '@craft-agent/server-core/transport';
import { createNodeCloudPeer } from '@craft-agent/server-core/cloud/peer-node';
import { COLLABORATION_RELAY_CAPABILITY, COLLABORATION_RELAY_RPC as C, RPC_CHANNELS, type CollaborationServerRef as ServerRef, type CollaborationSetupContext as SetupContext, type CollaborationRelaySelection as Selection, type CollaborationRelayCandidate as Candidate, type CollaborationRelayCreateInput as CreateInput, type CollaborationRelayCreateResult as CreateResult, type CollaborationRelayStatus as Status, type CollaborationRelayStatusLookup as Lookup, type CollaborationRelayInfo as Info, type CollaborationRelayMember as Member, type CollaborationRelayGroup as Group, type CollaborationRelayForward as Forward, type CollaborationRelayOperation as Operation, type CollaborationRelayDelivery as Delivery } from '@craft-agent/shared/protocol';
export interface RelayClient {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    handleCapability(channel: string, handler: (...args: any[]) => Promise<unknown>): void;
    destroy(): void;
}
export interface RelayResolvedServer {
    url: string;
    token: string;
    revision: string | number;
    name: string;
}
/** Derived from actual native WebContents + a main-owned workspace binding. */
export interface RelayWindowBinding {
    senderId: number;
    generation: string | number;
    server: ServerRef;
    serverWorkspaceId: string;
    serverName: string;
    workspaceName: string;
}
export interface CollaborationRelayDependencies {
    stateDirectory: string;
    getWindowBinding(event: unknown): RelayWindowBinding | Promise<RelayWindowBinding>;
    listServers(): Promise<Array<{
        server: ServerRef;
        name: string;
        credentialAvailable: boolean;
    }>>;
    resolveServer(server: ServerRef): Promise<RelayResolvedServer>;
    createClient?(server: RelayResolvedServer, workspaceId?: string): RelayClient;
}
interface Route {
    server: ServerRef;
    workspaceId: string;
    revision: string | number;
    endpointFingerprint: string;
    serverId: string;
    selections: Array<{
        id: string;
        role: 'primary' | 'secondary';
        name?: string;
        sessionId?: string;
        createNew?: true;
    }>;
    prepareStarted?: boolean;
    prepared?: Member[];
    committed?: boolean;
    aborted?: boolean;
    ended?: boolean;
}
interface Journal extends CreateResult {
    schema: 1;
    ownerId: string;
    epoch: string;
    primary: SetupContext['primary'];
    secondaries: Selection[];
    fingerprint: string;
    routes: Route[];
    group?: Group;
    lastSyncedAt?: number;
    pendingDeliveries: number;
    pendingOperations: number;
}
interface Context {
    value: SetupContext;
    binding: RelayWindowBinding;
    createdAt: number;
}
interface Connection {
    client: RelayClient;
    server: ServerRef;
    workspaceId?: string;
    revision: string | number;
    fingerprint: string;
    info: Info;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refKey = (server: ServerRef) => server.kind === 'local' ? 'local' : `saved:${server.profileId}`;
const routeKey = (server: ServerRef, workspaceId?: string) => JSON.stringify([refKey(server), workspaceId ?? null]);
const primaryKey = (p: SetupContext['primary']) => routeKey(p.server, p.workspaceId) + '/' + p.sessionId;
const idPattern = /^[A-Za-z0-9_-]{8,160}$/;
class BindingChangedError extends Error {
}
class AccessUnavailableError extends Error {
}
const safeError = () => ({ code: 'RELAY_PAUSED', message: 'Collaboration relay is paused. Check saved-server credentials, verified TLS, server compatibility, and participant availability.' });
function validRef(value: ServerRef): ServerRef {
    if (value?.kind === 'local')
        return { kind: 'local' };
    if (value?.kind === 'saved' && typeof value.profileId === 'string' && value.profileId.length > 0 && value.profileId.length < 200)
        return { kind: 'saved', profileId: value.profileId };
    throw new Error('Choose a saved server or the local server');
}
function text(value: unknown, label: string, max = 200): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`Invalid collaboration ${label}`);
    return value;
}
export function validateRelayUrl(value: string): string {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)))
        throw new Error('Collaboration relay requires verified WSS, except owned loopback connections');
    return url.toString().replace(/\/$/, '');
}
function info(value: unknown): Info {
    const v = value as Info;
    if (!v || v.protocolVersion !== 1 || typeof v.serverId !== 'string' || !v.serverId || v.serverId.length > 200 || !Array.isArray(v.features) || !['durable-inbox-v1', 'prepared-members-v1', 'member-routing-v1'].every(f => v.features.includes(f as any)))
        throw new Error('Server does not support collaboration-relay/v1; upgrade it before creating this group');
    return v;
}
export class CollaborationRelayManager {
    private contexts = new Map<string, Context>();
    private journals = new Map<string, Journal>();
    private connections = new Map<string, Connection>();
    private opening = new Map<string, {
        revision: string | number;
        fingerprint: string;
        promise: Promise<Connection>;
        client?: RelayClient;
    }>();
    private pendingClients = new Set<RelayClient>();
    private locks = new Map<string, Promise<unknown>>();
    private ownerId = '';
    private initialized: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private ticking = false;
    private stopped = false;
    constructor(private readonly deps: CollaborationRelayDependencies) { this.initialized = this.load(); }
    private async load() {
        await mkdir(this.deps.stateDirectory, { recursive: true, mode: 0o700 });
        const ownerPath = join(this.deps.stateDirectory, 'owner-id');
        try {
            this.ownerId = (await readFile(ownerPath, 'utf8')).trim();
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            this.ownerId = randomUUID();
            try {
                await writeFile(ownerPath, this.ownerId, { flag: 'wx', mode: 0o600 });
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
                this.ownerId = (await readFile(ownerPath, 'utf8')).trim();
            }
        }
        await this.readJournals();
    }
    private async readJournals(onlyPrimaryKey?: string): Promise<void> {
        for (const file of await readdir(this.deps.stateDirectory)) {
            if (!file.endsWith('.json') || !idPattern.test(file.slice(0, -5)))
                continue;
            const j = JSON.parse(await readFile(join(this.deps.stateDirectory, file), 'utf8')) as Journal;
            if (j.schema !== 1 || j.ownerId !== this.ownerId || !idPattern.test(j.operationId))
                throw new Error('Invalid persisted collaboration relay journal');
            if (onlyPrimaryKey && primaryKey(j.primary) !== onlyPrimaryKey)
                continue;
            const existing = this.journals.get(j.operationId);
            if (existing)
                Object.assign(existing, j);
            else
                this.journals.set(j.operationId, j);
        }
    }
    async start() {
        await this.initialized;
        if (this.timer || this.stopped)
            return;
        this.timer = setInterval(() => { void this.tick().catch(() => { }); }, 1000);
        this.timer.unref?.();
        void this.tick().catch(() => { });
    }
    private async save(j: Journal) { const path = join(this.deps.stateDirectory, `${j.operationId}.json`), tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(j), { mode: 0o600 }); await rename(tmp, path); this.journals.set(j.operationId, j); }
    private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const work = (this.locks.get(key) ?? Promise.resolve()).catch(() => { }).then(async () => {
            const directory = join(this.deps.stateDirectory, '.locks');
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const path = join(directory, hash(key)), deadline = Date.now() + 10000;
            for (;;) {
                try {
                    await mkdir(path);
                    await writeFile(join(path, 'owner'), String(process.pid), { mode: 0o600 });
                    break;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                        throw error;
                    let dead = false;
                    try {
                        const pid = Number(await readFile(join(path, 'owner'), 'utf8'));
                        if (Number.isSafeInteger(pid) && pid > 0) {
                            try {
                                process.kill(pid, 0);
                            }
                            catch (e) {
                                dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
                            }
                        }
                    }
                    catch {
                        try {
                            dead = Date.now() - (await stat(path)).mtimeMs > 120000;
                        }
                        catch { }
                    }
                    if (dead) {
                        await rm(path, { recursive: true, force: true });
                        continue;
                    }
                    if (Date.now() >= deadline)
                        throw new Error('Another application instance is updating this collaboration');
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            }
            try {
                await this.readJournals(key);
                return await fn();
            }
            finally {
                await rm(path, { recursive: true, force: true });
            }
        });
        this.locks.set(key, work);
        void work.finally(() => {
            if (this.locks.get(key) === work)
                this.locks.delete(key);
        }).catch(() => { });
        return work;
    }
    private scope(j: Journal) { return { groupId: j.groupId, epoch: j.epoch, ownerId: j.ownerId }; }
    private result(j: Journal): CreateResult { return { groupId: j.groupId, operationId: j.operationId, state: j.state, activationStatus: j.activationStatus, memberCount: j.memberCount, ...(j.warnings?.length ? { warnings: j.warnings } : {}) }; }
    private async binding(event: unknown) { const b = await this.deps.getWindowBinding(event); return { ...b, server: validRef(b.server) }; }
    private async connection(server: ServerRef, workspaceId?: string): Promise<Connection> {
        if (this.stopped)
            throw new Error('Collaboration relay is stopped');
        server = validRef(server);
        let resolved: RelayResolvedServer;
        try {
            resolved = await this.deps.resolveServer(server);
        }
        catch {
            throw new AccessUnavailableError('Saved server credential cannot be resolved');
        }
        const url = validateRelayUrl(resolved.url);
        if (!resolved.token || resolved.revision === undefined)
            throw new AccessUnavailableError('Saved server credential is unavailable');
        if (this.stopped)
            throw new Error('Collaboration relay is stopped');
        const fingerprint = hash(url), key = routeKey(server, workspaceId), old = this.connections.get(key);
        if (old && old.revision === resolved.revision && old.fingerprint === fingerprint)
            return old;
        old?.client.destroy();
        this.connections.delete(key);
        const previousOpening = this.opening.get(key);
        if (previousOpening && previousOpening.revision === resolved.revision && previousOpening.fingerprint === fingerprint)
            return previousOpening.promise;
        previousOpening?.client?.destroy();
        const entry: {
            revision: string | number;
            fingerprint: string;
            promise: Promise<Connection>;
            client?: RelayClient;
        } = { revision: resolved.revision, fingerprint, promise: undefined! };
        this.opening.set(key, entry);
        entry.promise = (async () => {
            const endpoint = { ...resolved, url };
            const client: RelayClient = this.deps.createClient?.(endpoint, workspaceId) ?? new WsRpcClient(url, { token: resolved.token, workspaceId, autoReconnect: false, tlsRejectUnauthorized: true, useNodeWebSocket: true, cloudPeerFactory: createNodeCloudPeer, maxPayloadBytes: 16 * 1024 * 1024, clientCapabilities: [COLLABORATION_RELAY_CAPABILITY] });
            entry.client = client;
            this.pendingClients.add(client);
            client.handleCapability(COLLABORATION_RELAY_CAPABILITY, async (request) => {
                try {
                    return await this.forward(server, workspaceId, request);
                }
                catch {
                    throw new Error('Collaboration relay forwarding is unavailable. Check the relay status before retrying.');
                }
            });
            try {
                const connection = { client, server, workspaceId, revision: resolved.revision, fingerprint, info: info(await client.invoke(C.INFO)) };
                if (this.stopped || this.opening.get(key) !== entry)
                    throw new Error('Collaboration relay connection was superseded');
                this.connections.set(key, connection);
                return connection;
            }
            catch (error) {
                client.destroy();
                if ((error as {
                    code?: string;
                })?.code === 'AUTH_FAILED')
                    throw new AccessUnavailableError('Saved server authentication failed');
                throw new Error('Saved server is unavailable or lacks collaboration-relay/v1');
            }
            finally {
                this.pendingClients.delete(client);
                if (this.opening.get(key) === entry)
                    this.opening.delete(key);
            }
        })();
        return entry.promise;
    }
    private releaseIfUnused(connection: Connection): void {
        const needed = [...this.journals.values()].some(j => !['aborted', 'paused'].includes(j.state) && j.routes.some(r => routeKey(r.server, r.workspaceId) === routeKey(connection.server, connection.workspaceId) && (j.state !== 'ended' || (r.prepareStarted && !r.ended))));
        if (!needed && this.connections.get(routeKey(connection.server, connection.workspaceId)) === connection) {
            this.connections.delete(routeKey(connection.server, connection.workspaceId));
            connection.client.destroy();
        }
    }
    private async pinned(route: Route, revalidate = false): Promise<Connection> {
        const connection = await this.connection(route.server, route.workspaceId);
        if (route.server.kind === 'local' && connection.info.serverId === route.serverId) {
            route.revision = connection.revision;
            route.endpointFingerprint = connection.fingerprint;
        }
        if (connection.info.serverId !== route.serverId || (!revalidate && (connection.revision !== route.revision || connection.fingerprint !== route.endpointFingerprint)))
            throw new BindingChangedError('Saved server binding changed; explicit validation is required');
        if (revalidate) {
            route.revision = connection.revision;
            route.endpointFingerprint = connection.fingerprint;
        }
        return connection;
    }
    private async call(route: Route, channel: string, input: unknown) {
        const c = await this.pinned(route);
        try {
            return await c.client.invoke(channel, input);
        }
        catch (e) {
            c.client.destroy();
            if (this.connections.get(routeKey(route.server, route.workspaceId)) === c)
                this.connections.delete(routeKey(route.server, route.workspaceId));
            throw e;
        }
    }
    async setup(event: unknown, primarySessionId: string): Promise<SetupContext> {
        await this.initialized;
        if (!this.locks.size)
            await this.readJournals();
        const binding = await this.binding(event), sessionId = text(primarySessionId, 'primary session');
        const connection = await this.connection(binding.server, binding.serverWorkspaceId);
        const candidates = await connection.client.invoke(RPC_CHANNELS.collaborations.LIST_CANDIDATES).finally(() => this.releaseIfUnused(connection)) as Array<{
            id: string;
            workspaceId: string;
            name?: string;
            isArchived?: boolean;
            hidden?: boolean;
        }>;
        const selected = candidates.find(s => s.id === sessionId && s.workspaceId === binding.serverWorkspaceId && !s.isArchived && !s.hidden);
        if (!selected)
            throw new Error('Primary session is not in the current native workspace');
        const primary: SetupContext['primary'] = { server: binding.server, serverName: binding.serverName, workspaceId: binding.serverWorkspaceId, workspaceName: binding.workspaceName, sessionId, sessionName: typeof selected.name === 'string' && selected.name.trim() ? selected.name.slice(0, 200) : sessionId };
        const contextId = randomUUID(), value: SetupContext = { contextId, primary, servers: (await this.deps.listServers()).map(row => ({ server: validRef(row.server), name: text(row.name, 'server name'), credentialAvailable: row.credentialAvailable === true })), relayProtocolVersion: 1, requiresRunningDesktop: true, pendingCreations: [...this.journals.values()].filter(j => primaryKey(j.primary) === primaryKey(primary) && j.state !== 'aborted' && (j.state !== 'ended' || j.routes.some(r => r.prepareStarted && !r.ended))).map(j => ({ ...this.result(j), secondaries: j.secondaries })) };
        if (hash(await this.binding(event)) !== hash(binding))
            throw new Error('Native collaboration binding changed');
        this.contexts.set(contextId, { value, binding, createdAt: Date.now() });
        for (const [id, ctx] of this.contexts)
            if (Date.now() - ctx.createdAt > 30 * 60000)
                this.contexts.delete(id);
        return value;
    }
    async workspaces(event: unknown, server: ServerRef) {
        await this.binding(event);
        const c = await this.connection(server);
        const rows = await c.client.invoke(RPC_CHANNELS.server.GET_WORKSPACES).finally(() => this.releaseIfUnused(c)) as Array<{
            id: string;
            name: string;
            remoteServer?: unknown;
        }>;
        if (!Array.isArray(rows))
            throw new Error('Invalid server workspace catalog');
        return rows.filter(w => !w.remoteServer).map(w => ({ id: text(w.id, 'workspace'), name: text(w.name, 'workspace name') }));
    }
    async candidates(event: unknown, server: ServerRef, workspaceId: string): Promise<Candidate[]> {
        await this.binding(event);
        server = validRef(server);
        const c = await this.connection(server, text(workspaceId, 'workspace'));
        const rows = await c.client.invoke(RPC_CHANNELS.collaborations.LIST_CANDIDATES).finally(() => this.releaseIfUnused(c)) as Array<{
            id: string;
            workspaceId: string;
            name?: string;
            isArchived?: boolean;
            hidden?: boolean;
            collaboration?: unknown;
        }>;
        if (!Array.isArray(rows))
            throw new Error('Invalid collaboration candidate catalog');
        return rows.filter(s => s.workspaceId === workspaceId && !s.hidden).map(s => ({ server, workspaceId, sessionId: text(s.id, 'session'), name: typeof s.name === 'string' ? s.name.slice(0, 200) : undefined, ...(s.isArchived || s.collaboration ? { unavailableReason: 'Session is archived or already belongs to a collaboration' } : {}) }));
    }
    private async context(event: unknown, id: string): Promise<Context> {
        const ctx = this.contexts.get(id), binding = await this.binding(event);
        if (!ctx || Date.now() - ctx.createdAt > 30 * 60000 || hash(binding) !== hash(ctx.binding))
            throw new Error('Collaboration setup context expired; reopen the dialog');
        return ctx;
    }
    private selections(values: Selection[]): Selection[] {
        if (!Array.isArray(values) || !values.length || values.length > 32)
            throw new Error('Choose between one and 32 collaborators');
        return values.map(s => {
            const base = { server: validRef(s.server), workspaceId: text(s.workspaceId, 'workspace'), ...(s.name !== undefined ? { name: text(s.name, 'session name') } : {}) };
            if (s.createNew === true) {
                if (s.sessionId !== undefined)
                    throw new Error('Ambiguous collaboration session');
                return { ...base, createNew: true };
            }
            ;
            return { ...base, sessionId: text(s.sessionId, 'session') };
        });
    }
    async create(event: unknown, input: CreateInput): Promise<CreateResult> {
        await this.initialized;
        const ctx = await this.context(event, input.contextId);
        if (!idPattern.test(input.operationId))
            throw new Error('Invalid collaboration operation ID');
        const secondaries = this.selections(input.secondaries), fingerprint = hash({ primary: primaryKey(ctx.value.primary), secondaries });
        return this.lock(primaryKey(ctx.value.primary), async () => {
            await this.context(event, input.contextId);
            let j = this.journals.get(input.operationId);
            if (j) {
                if (j.fingerprint !== fingerprint || primaryKey(j.primary) !== primaryKey(ctx.value.primary))
                    throw new Error('Creation operation ID was reused with different members');
                if (j.state === 'paused') {
                    for (const route of j.routes)
                        await this.pinned(route, true);
                    j.state = j.group ? 'committing' : 'preparing';
                    await this.save(j);
                }
                ;
                await this.advance(j);
                return this.result(j);
            }
            if ([...this.journals.values()].some(j => primaryKey(j.primary) === primaryKey(ctx.value.primary) && !['ended', 'aborted'].includes(j.state)))
                throw new Error('This primary already has an active or recovering collaboration');
            j = { schema: 1, operationId: input.operationId, groupId: `collab_${randomUUID()}`, epoch: randomUUID(), ownerId: this.ownerId, primary: ctx.value.primary, secondaries, fingerprint, routes: [], state: 'preparing', activationStatus: 'queued', memberCount: secondaries.length + 1, pendingDeliveries: 0, pendingOperations: 0 };
            await this.save(j);
            await this.advance(j);
            return this.result(j);
        });
    }
    private async preflight(j: Journal) {
        const all: Array<Selection & {
            id: string;
            role: 'primary' | 'secondary';
        }> = [{ server: j.primary.server, workspaceId: j.primary.workspaceId, sessionId: j.primary.sessionId, name: j.primary.sessionName, id: 'primary', role: 'primary' }, ...j.secondaries.map((s, i) => ({ ...s, id: `secondary_${i + 1}`, role: 'secondary' as const }))];
        const identities = new Set<string>(), grouped = new Map<string, Route>();
        for (const selected of all) {
            const key = routeKey(selected.server, selected.workspaceId);
            let route = grouped.get(key);
            if (!route) {
                const c = await this.connection(selected.server, selected.workspaceId);
                route = { server: selected.server, workspaceId: selected.workspaceId, revision: c.revision, endpointFingerprint: c.fingerprint, serverId: c.info.serverId, selections: [] };
                grouped.set(key, route);
            }
            if (!selected.createNew) {
                const identity = JSON.stringify([route.serverId, selected.workspaceId, selected.sessionId]);
                if (identities.has(identity))
                    throw new Error('A session can only appear once in a collaboration');
                identities.add(identity);
                const c = await this.pinned(route);
                const candidates = await c.client.invoke(RPC_CHANNELS.collaborations.LIST_CANDIDATES) as Array<{
                    id: string;
                    workspaceId: string;
                    collaboration?: unknown;
                    hidden?: boolean;
                    isArchived?: boolean;
                }>;
                const s = candidates.find(s => s.id === selected.sessionId && s.workspaceId === selected.workspaceId);
                if (!s || s.collaboration || s.hidden || s.isArchived)
                    throw new Error('Selected session is unavailable');
            }
            route.selections.push({ id: selected.id, role: selected.role, name: selected.name, ...(selected.createNew ? { createNew: true } : { sessionId: selected.sessionId }) });
        }
        j.routes = [...grouped.values()];
        if (new Set(j.routes.map(r => JSON.stringify([r.serverId, r.workspaceId]))).size !== j.routes.length)
            throw new Error('Choose one saved profile per server workspace');
        await this.save(j);
    }
    private async bind(j: Journal, route: Route) { return this.call(route, C.BIND, this.scope(j)); }
    private coordinator(j: Journal): Route {
        const found = j.routes.find(r => r.selections.some(s => s.role === 'primary'));
        if (!found)
            throw new Error('Collaboration coordinator route is missing');
        return found;
    }
    private async advance(j: Journal): Promise<void> {
        try {
            if (j.state === 'preparing') {
                if (!j.routes.length)
                    await this.preflight(j);
                const coordinator = this.coordinator(j);
                for (const route of j.routes) {
                    if (route.prepared)
                        continue;
                    route.prepareStarted = true;
                    await this.save(j);
                    const members = await this.call(route, C.PREPARE, { ...this.scope(j), operationId: j.operationId, coordinator: { serverId: coordinator.serverId, workspaceId: coordinator.workspaceId }, members: route.selections }) as Member[];
                    if (!Array.isArray(members) || members.length !== route.selections.length || members.some(m => m.serverId !== route.serverId || m.workspaceId !== route.workspaceId || !route.selections.some(s => s.id === m.id && s.role === m.role && (s.createNew || s.sessionId === m.sessionId))))
                        throw new Error('Prepared server membership did not match selected participants');
                    route.prepared = members.map(m => ({ id: text(m.id, 'member'), role: m.role, serverId: text(m.serverId, 'server identity'), workspaceId: route.workspaceId, sessionId: text(m.sessionId, 'session'), ...(m.name ? { name: text(m.name, 'member name') } : {}) }));
                    if (new Set(route.prepared.map(m => m.id)).size !== route.prepared.length)
                        throw new Error('Duplicate prepared member');
                    await this.save(j);
                }
                const now = Date.now();
                j.group = { ...this.scope(j), version: 2, revision: 0, state: 'committing', coordinator: { serverId: coordinator.serverId, workspaceId: coordinator.workspaceId }, primaryMemberId: 'primary', members: j.routes.flatMap(r => r.prepared!), board: {}, files: {}, events: [], createdAt: now, updatedAt: now };
                j.state = 'committing';
                await this.save(j);
            }
            if (j.state === 'committing') {
                // Retry the durable decision write before any irreversible commit RPC.
                await this.save(j);
                for (const route of j.routes) {
                    await this.bind(j, route);
                    if (!route.committed) {
                        await this.call(route, C.COMMIT, { ...this.scope(j), group: j.group });
                        route.committed = true;
                        await this.save(j);
                    }
                }
                j.group = await this.call(this.coordinator(j), C.GROUP, { ...this.scope(j), action: 'activate' }) as Group;
                j.state = 'active';
                j.warnings = [];
                await this.save(j);
            }
            if (j.state === 'aborting') {
                await this.save(j);
                for (const route of j.routes)
                    if (route.prepareStarted && !route.aborted) {
                        const cleanup = await this.call(route, C.ABORT, this.scope(j)) as {
                            retainedSessionIds?: string[];
                        };
                        if (cleanup.retainedSessionIds?.length)
                            j.warnings = [...(j.warnings ?? []), { code: 'CREATED_CHAT_RETAINED', message: 'A newly created collaborator chat was changed or its untouched state could not be verified. It was detached and kept.' }];
                        route.aborted = true;
                        await this.save(j);
                    }
                j.state = 'aborted';
                j.activationStatus = 'failed';
                await this.save(j);
            }
            if (j.state === 'active')
                await this.pump(j);
        }
        catch (error) {
            if (this.stopped)
                return;
            if (error instanceof BindingChangedError || error instanceof AccessUnavailableError) {
                j.state = 'paused';
                j.warnings = [safeError()];
                await this.save(j);
                return;
            }
            if (j.state === 'preparing') {
                j.state = 'aborting';
                j.warnings = [safeError()];
                await this.save(j);
                try {
                    await this.advance(j);
                }
                catch { }
            }
            else {
                j.warnings = [safeError()];
                await this.save(j);
            }
        }
    }
    private routeForMember(j: Journal, memberId: string): Route {
        const member = j.group?.members.find(m => m.id === memberId);
        const route = member && j.routes.find(r => r.serverId === member.serverId && r.workspaceId === member.workspaceId && r.prepared?.some(m => m.id === memberId));
        if (!route)
            throw new Error('Member is outside the enrolled relay routes');
        return route;
    }
    private async forward(server: ServerRef, workspaceId: string | undefined, request: Forward): Promise<unknown> {
        await this.initialized;
        const scope = request.kind === 'operation' ? request.operation : request;
        const j = [...this.journals.values()].find(j => j.groupId === scope.groupId);
        if (!j || j.state !== 'active' || j.epoch !== scope.epoch || j.ownerId !== scope.ownerId || !workspaceId)
            throw new Error('Relay group is unavailable');
        const memberId = request.kind === 'operation' ? request.operation.memberId : request.memberId;
        const origin = this.routeForMember(j, memberId);
        if (routeKey(origin.server, origin.workspaceId) !== routeKey(server, workspaceId))
            throw new Error('Relay origin is not authorized for this member');
        await this.pinned(origin);
        const coordinator = this.coordinator(j);
        await this.bind(j, coordinator);
        if (request.kind === 'operation')
            return this.call(coordinator, C.APPLY, request.operation);
        if (request.kind === 'read') {
            // Bring this participant's durable writes forward before a fresh read.
            // Normal primary user messages enqueue their goal without waiting on the network.
            const pending = await this.call(origin, C.PENDING, this.scope(j)) as {
                operations: Operation[];
            };
            for (const operation of pending.operations) {
                if (!origin.prepared?.some(m => m.id === operation.memberId))
                    throw new Error('Unenrolled relay operation actor');
                await this.call(coordinator, C.APPLY, operation);
                await this.call(origin, C.ACK, { ...this.scope(j), kind: 'operation', memberId: operation.memberId, sequence: operation.sequence });
            }
            return this.call(coordinator, C.GROUP, { ...this.scope(j), action: request.fileId ? 'file' : 'read', ...(request.fileId ? { fileId: request.fileId } : {}) });
        }
        throw new Error('Unsupported collaboration relay operation');
    }
    private async pump(j: Journal) {
        const coordinator = this.coordinator(j);
        await this.bind(j, coordinator);
        const head = await this.call(coordinator, C.PENDING, this.scope(j)) as {
            phase: string;
            groupState?: string;
        };
        if (head.phase === 'ended' || head.groupState === 'ended') {
            j.state = 'ended';
            if (j.group)
                j.group.state = 'ended';
            await this.save(j);
            return;
        }
        let operations = 0;
        for (const route of j.routes) {
            await this.bind(j, route);
            const pending = await this.call(route, C.PENDING, this.scope(j)) as {
                operations: Operation[];
                operationCount: number;
                retiredOperations: Record<string, number>;
            };
            operations += pending.operationCount;
            for (const operation of pending.operations) {
                if (!route.prepared?.some(m => m.id === operation.memberId))
                    throw new Error('Unenrolled relay operation actor');
                await this.forward(route.server, route.workspaceId, { kind: 'operation', operation });
                await this.call(route, C.ACK, { ...this.scope(j), kind: 'operation', memberId: operation.memberId, sequence: operation.sequence });
                operations--;
            }
            for (const [memberId, sequence] of Object.entries(pending.retiredOperations))
                if (sequence > 0)
                    await this.call(coordinator, C.ACK, { ...this.scope(j), kind: 'retireOperations', memberId, sequence });
        }
        const pending = await this.call(coordinator, C.PENDING, this.scope(j)) as {
            deliveries: Delivery[];
            deliveryCount: number;
            retiredDeliveries: Record<string, number>;
        };
        j.pendingDeliveries = pending.deliveryCount;
        j.pendingOperations = operations;
        for (const delivery of pending.deliveries) {
            const target = this.routeForMember(j, delivery.targetMemberId), member = j.group!.members.find(m => m.id === delivery.targetMemberId)!;
            if (hash(delivery.target) !== hash({ serverId: member.serverId, workspaceId: member.workspaceId, sessionId: member.sessionId }))
                throw new Error('Relay target address does not match enrolled participant');
            await this.call(target, C.ACCEPT, delivery);
            await this.call(coordinator, C.ACK, { ...this.scope(j), kind: 'delivery', memberId: delivery.targetMemberId, sequence: delivery.sequence });
            j.pendingDeliveries--;
            if (delivery.operationId === 'activation')
                j.activationStatus = 'started';
        }
        for (const [memberId, sequence] of Object.entries(pending.retiredDeliveries))
            if (sequence > 0)
                await this.call(this.routeForMember(j, memberId), C.ACK, { ...this.scope(j), kind: 'retireDeliveries', memberId, sequence });
        j.group = await this.call(coordinator, C.GROUP, { ...this.scope(j), action: 'read' }) as Group;
        j.lastSyncedAt = Date.now();
        j.warnings = [];
        await this.save(j);
    }
    private visible(j: Journal, b: RelayWindowBinding): boolean {
        return routeKey(j.primary.server, j.primary.workspaceId) === routeKey(b.server, b.serverWorkspaceId)
            || j.routes.some(r => routeKey(r.server, r.workspaceId) === routeKey(b.server, b.serverWorkspaceId) && !!r.prepared?.length);
    }
    private journal(b: RelayWindowBinding, lookup: Lookup, primaryOnly = false): Journal {
        const j = 'operationId' in lookup ? this.journals.get(lookup.operationId) : [...this.journals.values()].find(j => j.groupId === lookup.groupId);
        if (!j || !this.visible(j, b) || (primaryOnly && routeKey(j.primary.server, j.primary.workspaceId) !== routeKey(b.server, b.serverWorkspaceId)))
            throw new Error('Collaboration is outside this native workspace authority');
        return j;
    }
    private statusValue(j: Journal, b: RelayWindowBinding): Status {
        return { ...this.result(j), requiresRunningDesktop: true, lastSyncedAt: j.lastSyncedAt, pendingDeliveries: j.pendingDeliveries, pendingOperations: j.pendingOperations, canEnd: routeKey(j.primary.server, j.primary.workspaceId) === routeKey(b.server, b.serverWorkspaceId), ...(j.group ? { group: structuredClone(j.group) } : {}) };
    }
    async status(event: unknown, lookup: Lookup): Promise<Status> { await this.initialized; const b = await this.binding(event); return this.statusValue(this.journal(b, lookup), b); }
    async list(event: unknown): Promise<Status[]> { await this.initialized; const b = await this.binding(event); return [...this.journals.values()].filter(j => this.visible(j, b)).map(j => this.statusValue(j, b)); }
    async file(event: unknown, lookup: Lookup, fileId: string): Promise<{
        file: import('@craft-agent/shared/protocol').CollaborationRelayFile;
        dataBase64: string;
    }> {
        await this.initialized;
        const b = await this.binding(event), j = this.journal(b, lookup);
        if (!/^[a-f0-9]{64}$/.test(fileId) || !j.group?.files[fileId])
            throw new Error('Shared collaboration file not found');
        const coordinator = this.coordinator(j);
        await this.bind(j, coordinator);
        const result = await this.call(coordinator, C.GROUP, { ...this.scope(j), action: 'file', fileId }) as {
            file: import('@craft-agent/shared/protocol').CollaborationRelayFile;
            dataBase64: string;
        };
        if (typeof result.dataBase64 !== 'string' || result.dataBase64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || result.file.id !== fileId)
            throw new Error('Invalid shared collaboration file');
        const bytes = Buffer.from(result.dataBase64, 'base64');
        if (bytes.length !== result.file.size || createHash('sha256').update(bytes).digest('hex') !== result.file.sha256)
            throw new Error('Shared collaboration file integrity failed');
        if (hash(await this.binding(event)) !== hash(b))
            throw new Error('Native collaboration binding changed');
        return { file: { id: fileId, name: text(result.file.name, 'file name', 255), size: bytes.length, sha256: result.file.sha256, updatedBy: text(result.file.updatedBy, 'member'), ...(result.file.contentType ? { contentType: text(result.file.contentType, 'content type', 255) } : {}) }, dataBase64: result.dataBase64 };
    }
    async end(event: unknown, lookup: Lookup): Promise<Status> {
        await this.initialized;
        const b = await this.binding(event), j = this.journal(b, lookup, true);
        await this.lock(primaryKey(j.primary), async () => {
            if (hash(await this.binding(event)) !== hash(b))
                throw new Error('Native collaboration binding changed');
            if (!j.group && ['preparing', 'aborting', 'paused'].includes(j.state)) {
                j.state = 'aborting';
                await this.save(j);
                await this.advance(j);
                return;
            }
            // Persist ending intent before any RPC: a lost reply cannot restart work.
            j.state = 'ended';
            await this.save(j);
            const ordered = [...j.routes].sort((a, b) => Number(b.selections.some(s => s.role === 'primary')) - Number(a.selections.some(s => s.role === 'primary')));
            for (const route of ordered)
                if (route.prepareStarted && !route.ended) {
                    try {
                        await this.call(route, C.END, this.scope(j));
                        route.ended = true;
                    }
                    catch {
                        j.warnings = [{ code: 'END_PENDING', message: 'Ending was requested. Offline participants still need to acknowledge detachment; already-running work may continue.' }];
                    }
                    await this.save(j);
                }
            if (j.routes.every(r => !r.prepareStarted || r.ended)) {
                j.warnings = [];
                await this.save(j);
            }
        });
        return this.status(event, lookup);
    }
    async tick(): Promise<void> {
        await this.initialized;
        if (this.stopped || this.ticking)
            return;
        this.ticking = true;
        try {
            for (const j of this.journals.values()) {
                if (this.stopped)
                    break;
                if (['aborted', 'paused'].includes(j.state))
                    continue;
                try {
                    await this.lock(primaryKey(j.primary), async () => {
                        if (j.state === 'ended') {
                            await this.save(j);
                            for (const route of j.routes)
                                if (route.prepareStarted && !route.ended) {
                                    try {
                                        await this.call(route, C.END, this.scope(j));
                                        route.ended = true;
                                        if (j.routes.every(r => !r.prepareStarted || r.ended))
                                            j.warnings = [];
                                        await this.save(j);
                                    }
                                    catch { }
                                }
                            return;
                        }
                        await this.advance(j);
                    });
                }
                catch {
                    j.warnings = [safeError()];
                }
            }
        }
        finally {
            for (const connection of this.connections.values())
                this.releaseIfUnused(connection);
            this.ticking = false;
        }
    }
    async close() {
        this.stopped = true;
        if (this.timer)
            clearInterval(this.timer);
        for (const c of this.connections.values())
            c.client.destroy();
        for (const client of this.pendingClients)
            client.destroy();
        this.connections.clear();
        this.pendingClients.clear();
        this.opening.clear();
        await Promise.allSettled(this.locks.values());
        this.contexts.clear();
    }
}

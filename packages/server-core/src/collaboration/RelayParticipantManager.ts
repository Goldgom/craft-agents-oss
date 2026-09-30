/** Server-local half of the Electron-owned relay. It never resolves URLs or secrets. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfigDir } from '@craft-agent/shared/config/paths';
import type { SessionCollaboration } from '@craft-agent/shared/sessions';
import type { ISessionManager } from '../handlers/session-manager-interface';
import type { CollaborationRelayDelivery as Delivery, CollaborationRelayForward as Forward, CollaborationRelayGroup as Group, CollaborationRelayInfo, CollaborationRelayMember as Member, CollaborationRelayOperation as Operation, CollaborationRelayOperationInput as OperationInput, CollaborationRelayPrepareInput as Prepare, CollaborationRelayReceipt as Receipt, CollaborationRelayScope as Scope } from '@craft-agent/shared/protocol';
import { COLLABORATION_RELAY_CAPABILITY } from '@craft-agent/shared/protocol';
const LIMIT = 256;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_GROUP = 6 * 1024 * 1024;
const GROUP = /^collab_[0-9a-f-]{36}$/i;
const ID = /^(?:primary|secondary_[1-9][0-9]{0,2})$/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionFingerprint = (session: Record<string, unknown>) => hash(Object.fromEntries(['name', 'isFlagged', 'permissionMode', 'sessionStatus', 'labels', 'enabledSourceSlugs', 'workingDirectory', 'model', 'llmConnection', 'thinkingLevel', 'isArchived', 'hidden', 'projectId'].map(key => [key, session[key]])));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const field = (value: unknown, name: string, max = 200) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`Invalid relay ${name}`);
    return value;
};
const safeMap = <T>() => Object.create(null) as Record<string, T>;
interface SequenceState<T> {
    retired: number;
    latest: number;
    receipts: Record<string, T>;
}
interface RecordState {
    schema: 1;
    scope: Scope;
    creationOperationId: string;
    prepareHash: string;
    phase: 'prepared' | 'active' | 'ended' | 'aborted';
    retainedSessions?: string[];
    coordinator: Prepare['coordinator'];
    members: Member[];
    group?: Group;
    operations: Operation[];
    operationSequence: Record<string, number>;
    retiredOperations: Record<string, number>;
    applied: Record<string, SequenceState<{
        digest: string;
        result: unknown;
    }>>;
    deliveries: Delivery[];
    deliverySequence: Record<string, number>;
    retiredDeliveries: Record<string, number>;
    inbox: Record<string, SequenceState<{
        digest: string;
        receipt: Receipt;
    }>>;
}
interface Binding {
    clientId: string;
    ownerId: string;
    expiresAt: number;
    alive?: () => boolean;
    invoke: (value: Forward) => Promise<unknown>;
}
export interface RelaySessionDependencies extends Pick<ISessionManager, 'getSession' | 'getSessions' | 'createSession' | 'deleteSession' | 'setSessionCollaboration' | 'notifySessionCreated'> {
    acceptCollaborationRelayMessage?(sessionId: string, delivery: Delivery): Promise<Receipt>;
}
export class RelayParticipantManager {
    private queues = new Map<string, Promise<unknown>>();
    private bindings = new Map<string, Binding>();
    private identity?: Promise<string>;
    constructor(private readonly deps: {
        sessions: RelaySessionDependencies;
        workspaceRoot: (id: string) => string;
        stateRoot?: string;
    }) { }
    private key(workspaceId: string, groupId: string) {
        if (!GROUP.test(groupId))
            throw new Error('Invalid relay group');
        this.deps.workspaceRoot(workspaceId);
        return `${workspaceId}/${groupId}`;
    }
    private path(workspaceId: string, groupId: string) { this.key(workspaceId, groupId); return join(this.deps.workspaceRoot(workspaceId), '.tokenbird', 'collaboration-relay', `${groupId}.json`); }
    private async save(workspaceId: string, state: RecordState) { const path = this.path(workspaceId, state.scope.groupId); await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, path); }
    private async load(workspaceId: string, scope: Scope) {
        const state = JSON.parse(await readFile(this.path(workspaceId, scope.groupId), 'utf8')) as RecordState;
        if (state.schema !== 1 || state.scope.epoch !== scope.epoch || state.scope.ownerId !== scope.ownerId)
            throw new Error('Relay membership scope mismatch');
        return state;
    }
    private async locked<T>(workspaceId: string, groupId: string, run: () => Promise<T>): Promise<T> {
        const key = this.key(workspaceId, groupId);
        const work = (this.queues.get(key) ?? Promise.resolve()).catch(() => { }).then(async () => {
            const lock = `${this.path(workspaceId, groupId)}.lock`;
            await mkdir(join(lock, '..'), { recursive: true, mode: 0o700 });
            const end = Date.now() + 10000;
            for (;;) {
                try {
                    await mkdir(lock);
                    await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
                    break;
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                        throw e;
                    if (Date.now() > end)
                        throw new Error('Relay record is busy');
                    let dead = false;
                    try {
                        const pid = Number(await readFile(join(lock, 'owner'), 'utf8'));
                        if (Number.isSafeInteger(pid) && pid > 0) {
                            try {
                                process.kill(pid, 0);
                            }
                            catch (error) {
                                dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
                            }
                        }
                    }
                    catch {
                        try {
                            dead = Date.now() - (await stat(lock)).mtimeMs > 120000;
                        }
                        catch { }
                    }
                    if (dead)
                        await rm(lock, { recursive: true, force: true });
                    await new Promise(resolve => setTimeout(resolve, 15));
                }
            }
            try {
                return await run();
            }
            finally {
                await rm(lock, { recursive: true, force: true });
            }
        });
        this.queues.set(key, work);
        void work.finally(() => {
            if (this.queues.get(key) === work)
                this.queues.delete(key);
        }).catch(() => { });
        return work;
    }
    async info(): Promise<CollaborationRelayInfo> {
        this.identity ??= (async () => {
            const root = this.deps.stateRoot ?? getConfigDir();
            await mkdir(root, { recursive: true, mode: 0o700 });
            const path = join(root, 'collaboration-server-id');
            try {
                return field((await readFile(path, 'utf8')).trim(), 'server identity');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
                const id = randomUUID();
                try {
                    await writeFile(path, id, { flag: 'wx', mode: 0o600 });
                    return id;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                        throw error;
                    return field((await readFile(path, 'utf8')).trim(), 'server identity');
                }
            }
        })();
        return { protocolVersion: 1, serverId: await this.identity, features: ['durable-inbox-v1', 'prepared-members-v1', 'member-routing-v1'], limits: { members: 33, outstanding: LIMIT, fileBytes: MAX_FILE } };
    }
    private membership(scope: Scope, input: Prepare, member: {
        id: string;
        role: 'primary' | 'secondary';
    }, serverId: string, created = false): SessionCollaboration {
        return { groupId: scope.groupId, memberId: member.id, role: member.role, coordinatorWorkspaceId: input.coordinator.workspaceId, relay: { protocolVersion: 1, epoch: scope.epoch, serverId, coordinator: input.coordinator, ownerId: scope.ownerId, phase: 'prepared', creationOperationId: input.operationId, ...(created ? { createdForOperation: true } : {}) } };
    }
    async prepare(workspaceId: string, input: Prepare): Promise<Member[]> {
        field(input.epoch, 'epoch');
        field(input.ownerId, 'owner');
        field(input.operationId, 'operation');
        field(input.coordinator?.serverId, 'coordinator server');
        field(input.coordinator?.workspaceId, 'coordinator workspace');
        if (!Array.isArray(input.members) || !input.members.length || input.members.length > 33)
            throw new Error('Invalid relay member count');
        const ids = new Set<string>();
        const sessions = new Set<string>();
        for (const member of input.members) {
            if (!ID.test(member.id) || ids.has(member.id) || (member.role !== 'primary' && member.role !== 'secondary'))
                throw new Error('Invalid relay member');
            ids.add(member.id);
            if (member.name !== undefined && (typeof member.name !== 'string' || member.name.length > 200))
                throw new Error('Invalid relay name');
            if (member.createNew) {
                if (member.sessionId !== undefined)
                    throw new Error('Ambiguous relay session selection');
            }
            else {
                field(member.sessionId, 'session');
                if (sessions.has(member.sessionId!))
                    throw new Error('Duplicate relay session');
                sessions.add(member.sessionId!);
            }
        }
        const scope = { groupId: input.groupId, epoch: input.epoch, ownerId: input.ownerId };
        return this.locked(workspaceId, input.groupId, async () => {
            let state: RecordState;
            try {
                state = await this.load(workspaceId, scope);
                if (state.prepareHash !== hash(input) || state.creationOperationId !== input.operationId)
                    throw new Error('Relay creation operation mismatch');
                if (state.phase === 'ended' || state.phase === 'aborted')
                    throw new Error('Relay creation is closed');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
                state = { schema: 1, scope, creationOperationId: input.operationId, prepareHash: hash(input), phase: 'prepared', coordinator: input.coordinator, members: [], operations: [], operationSequence: safeMap(), retiredOperations: safeMap(), applied: safeMap(), deliveries: [], deliverySequence: safeMap(), retiredDeliveries: safeMap(), inbox: safeMap() };
                await this.save(workspaceId, state);
            }
            const serverId = (await this.info()).serverId;
            // Validate every existing selection before creating any fresh sessions.
            for (const member of input.members.filter(item => !item.createNew)) {
                const session = await this.deps.sessions.getSession(member.sessionId!);
                if (!session || session.workspaceId !== workspaceId || session.isArchived || session.hidden)
                    throw new Error('Selected relay session is unavailable');
                const c = session.collaboration;
                if (c && (c.groupId !== scope.groupId || c.memberId !== member.id || c.relay?.epoch !== scope.epoch))
                    throw new Error('Selected session already belongs to another collaboration');
            }
            for (const selected of input.members) {
                let session = selected.createNew ? this.deps.sessions.getSessions(workspaceId).find(s => s.collaboration?.groupId === scope.groupId && s.collaboration.memberId === selected.id && s.collaboration.relay?.creationOperationId === input.operationId) : await this.deps.sessions.getSession(selected.sessionId!);
                const justCreated = !session;
                if (!session)
                    session = await this.deps.sessions.createSession(workspaceId, { name: selected.name }, { emitCreatedEvent: false, collaboration: this.membership(scope, input, selected, serverId, true) });
                const membership = this.membership(scope, input, selected, serverId, selected.createNew === true);
                if (!this.deps.sessions.setSessionCollaboration)
                    throw new Error('Relay session membership is unavailable');
                if (session.collaboration && (session.collaboration.groupId !== scope.groupId || session.collaboration.memberId !== selected.id || session.collaboration.relay?.epoch !== scope.epoch))
                    throw new Error('Selected session was reserved concurrently');
                if (justCreated) {
                    const initial = await this.deps.sessions.getSession(session.id);
                    if (initial)
                        membership.relay!.createdSessionFingerprint = sessionFingerprint(initial as unknown as Record<string, unknown>);
                }
                if (!session.collaboration || justCreated)
                    await this.deps.sessions.setSessionCollaboration(session.id, membership);
                if (!state.members.some(m => m.id === selected.id))
                    state.members.push({ id: selected.id, role: selected.role, serverId, workspaceId, sessionId: session.id, name: selected.name ?? session.name });
                await this.save(workspaceId, state);
            }
            return clone(state.members);
        });
    }
    async bind(workspaceId: string, scope: Scope, clientId: string, invoke: (value: Forward) => Promise<unknown>, alive?: () => boolean): Promise<void> {
        await this.load(workspaceId, scope);
        const key = this.key(workspaceId, scope.groupId), previous = this.bindings.get(key);
        if (previous && previous.clientId !== clientId && previous.expiresAt > Date.now() && (previous.alive?.() ?? true))
            throw new Error('Relay is owned by another active connection');
        this.bindings.set(key, { clientId, ownerId: scope.ownerId, expiresAt: Date.now() + 30000, invoke, alive });
    }
    requireBinding(workspaceId: string, scope: Scope, clientId: string): void {
        const bound = this.bindings.get(this.key(workspaceId, scope.groupId));
        if (!bound || bound.clientId !== clientId || bound.ownerId !== scope.ownerId || bound.expiresAt < Date.now())
            throw new Error('Relay connection binding expired');
        bound.expiresAt = Date.now() + 30000;
    }
    async commit(workspaceId: string, scope: Scope, group: Group) {
        return this.locked(workspaceId, scope.groupId, async () => {
            const state = await this.load(workspaceId, scope);
            this.validateGroup(group, scope);
            if (state.phase === 'ended' || state.phase === 'aborted')
                throw new Error('Relay membership has ended');
            for (const local of state.members) {
                const member = group.members.find(m => m.id === local.id);
                if (hash(member) !== hash(local))
                    throw new Error('Relay prepared membership changed');
                const session = await this.deps.sessions.getSession(local.sessionId);
                if (session?.collaboration?.groupId !== scope.groupId || session.collaboration.relay?.epoch !== scope.epoch)
                    throw new Error('Relay membership is stale');
                if (state.phase !== 'active')
                    await this.deps.sessions.setSessionCollaboration!(local.sessionId, { ...session.collaboration, relay: { ...session.collaboration.relay, phase: 'active' } });
                if (session.collaboration.relay.createdForOperation)
                    this.deps.sessions.notifySessionCreated?.(workspaceId, local.sessionId);
            }
            if (state.phase === 'active' && state.group)
                return clone(state.members);
            state.phase = 'active';
            state.group = clone(group);
            await this.save(workspaceId, state);
            return clone(state.members);
        });
    }
    private validateGroup(group: Group, scope: Scope) {
        if (!group || group.version !== 2 || group.groupId !== scope.groupId || group.epoch !== scope.epoch || group.ownerId !== scope.ownerId || !Array.isArray(group.members) || group.members.length < 2 || group.members.length > 33)
            throw new Error('Invalid relay group');
        if (group.members.filter(m => m.role === 'primary').length !== 1 || !group.members.some(m => m.id === group.primaryMemberId && m.role === 'primary'))
            throw new Error('Invalid relay primary');
        const ids = new Set<string>(), addresses = new Set<string>();
        for (const m of group.members) {
            if (!ID.test(m.id) || ids.has(m.id))
                throw new Error('Invalid relay member');
            ids.add(m.id);
            field(m.serverId, 'server');
            field(m.workspaceId, 'workspace');
            field(m.sessionId, 'session');
            const address = JSON.stringify([m.serverId, m.workspaceId, m.sessionId]);
            if (addresses.has(address))
                throw new Error('Duplicate relay session');
            addresses.add(address);
        }
    }
    async abort(workspaceId: string, scope: Scope): Promise<{
        retainedSessionIds: string[];
    }> {
        return this.locked(workspaceId, scope.groupId, async () => {
            let state: RecordState;
            try {
                state = await this.load(workspaceId, scope);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                    return { retainedSessionIds: [] };
                throw e;
            }
            if (state.phase === 'active')
                throw new Error('Committed relay must be ended, not rolled back');
            const retained = new Set(state.retainedSessions ?? []);
            for (const session of this.deps.sessions.getSessions(workspaceId)) {
                const c = session.collaboration;
                if (c?.groupId !== scope.groupId || c.relay?.epoch !== scope.epoch)
                    continue;
                const full = await this.deps.sessions.getSession(session.id);
                const untouched = full && c.relay.createdSessionFingerprint && c.relay.createdSessionFingerprint === sessionFingerprint(full as unknown as Record<string, unknown>);
                if (c.relay.createdForOperation && untouched && full.messages.length === 0 && !full.isProcessing)
                    await this.deps.sessions.deleteSession(session.id);
                else {
                    await this.deps.sessions.setSessionCollaboration!(session.id, null);
                    if (c.relay.createdForOperation) {
                        retained.add(session.id);
                        this.deps.sessions.notifySessionCreated?.(workspaceId, session.id);
                    }
                }
            }
            state.phase = 'aborted';
            state.retainedSessions = [...retained];
            await this.save(workspaceId, state);
            this.bindings.delete(this.key(workspaceId, scope.groupId));
            return { retainedSessionIds: state.retainedSessions };
        });
    }
    async end(workspaceId: string, scope: Scope): Promise<void> {
        await this.locked(workspaceId, scope.groupId, async () => {
            let state: RecordState;
            try {
                state = await this.load(workspaceId, scope);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                    return;
                throw e;
            }
            ;
            state.phase = 'ended';
            if (state.group && state.group.state !== 'ended') {
                state.group.state = 'ended';
                state.group.revision++;
                state.group.updatedAt = Date.now();
            }
            ;
            await this.save(workspaceId, state);
            for (const member of state.members) {
                const s = await this.deps.sessions.getSession(member.sessionId);
                if (s?.collaboration?.groupId === scope.groupId && s.collaboration.relay?.epoch === scope.epoch)
                    await this.deps.sessions.setSessionCollaboration!(member.sessionId, null);
            }
            ;
            this.bindings.delete(this.key(workspaceId, scope.groupId));
        });
    }
    private coordinator(state: RecordState, workspaceId: string, serverId: string): Group {
        if (!state.group || state.coordinator.serverId !== serverId || state.coordinator.workspaceId !== workspaceId)
            throw new Error('Not the relay coordinator');
        return state.group;
    }
    async readGroup(workspaceId: string, scope: Scope, fileId?: string): Promise<unknown> {
        const state = await this.load(workspaceId, scope), group = this.coordinator(state, workspaceId, (await this.info()).serverId);
        if (!fileId)
            return clone(group);
        if (!/^[a-f0-9]{64}$/.test(fileId) || !group.files[fileId])
            throw new Error('Shared relay file not found');
        const file = group.files[fileId]!, data = await readFile(join(this.path(workspaceId, scope.groupId) + '.files', file.sha256));
        if (createHash('sha256').update(data).digest('hex') !== file.sha256)
            throw new Error('Shared relay file integrity failed');
        return { file, dataBase64: data.toString('base64') };
    }
    async activate(workspaceId: string, scope: Scope) {
        return this.locked(workspaceId, scope.groupId, async () => {
            const state = await this.load(workspaceId, scope), group = this.coordinator(state, workspaceId, (await this.info()).serverId);
            if (state.phase !== 'active')
                throw new Error('Relay membership is not committed');
            if (group.state === 'active')
                return clone(group);
            if (group.state === 'ended')
                throw new Error('Relay has ended');
            group.state = 'active';
            group.revision++;
            group.updatedAt = Date.now();
            const primary = group.members.find(m => m.id === group.primaryMemberId)!;
            const session = await this.deps.sessions.getSession(primary.sessionId);
            const goal = [...(session?.messages ?? [])].reverse().find(m => m.role === 'user' && !m.hidden && m.content.trim());
            if (goal && goal.content.length > 256 * 1024)
                throw new Error('Relay goal exceeds the shared-board size limit');
            if (goal)
                group.board['goal.current'] = { value: { kind: 'goal', text: goal.content, status: 'active' }, revision: group.revision, updatedBy: primary.id, updatedAt: Date.now() };
            this.enqueueDelivery(state, group, 'activation', primary.id, 'relay-system', '[Collaboration started]\nRead collaboration_board for the shared goal and members. Dispatch bounded work using member IDs. Report meaningful progress and combine verified results. If the goal is missing, ask the user before dispatching.', true);
            await this.save(workspaceId, state);
            return clone(group);
        });
    }
    private enqueueDelivery(state: RecordState, group: Group, operationId: string, targetMemberId: string, sourceMemberId: string, message: string, hidden = false) {
        if (state.deliveries.length >= LIMIT)
            throw new Error('Relay delivery backlog is full');
        const target = group.members.find(m => m.id === targetMemberId);
        if (!target)
            throw new Error('Relay target is not a member');
        const sequence = (state.deliverySequence[targetMemberId] ?? 0) + 1;
        state.deliverySequence[targetMemberId] = sequence;
        const delivery = { ...state.scope, operationId, sequence, targetMemberId, sourceMemberId, target: { serverId: target.serverId, workspaceId: target.workspaceId, sessionId: target.sessionId }, message, ...(hidden ? { hidden: true } : {}) };
        state.deliveries.push({ ...delivery, digest: hash(delivery) });
    }
    async apply(workspaceId: string, operation: Operation): Promise<unknown> {
        return this.locked(workspaceId, operation.groupId, async () => {
            const state = await this.load(workspaceId, operation), group = this.coordinator(state, workspaceId, (await this.info()).serverId);
            if (group.state !== 'active' || state.phase !== 'active')
                throw new Error('Relay group is not active');
            const member = group.members.find(m => m.id === operation.memberId);
            if (!member)
                throw new Error('Relay actor is not a member');
            if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1)
                throw new Error('Invalid relay sequence');
            field(operation.operationId, 'operation');
            const digest = hash(operation);
            const seq = state.applied[member.id] ??= { retired: 0, latest: 0, receipts: safeMap() };
            if (operation.sequence <= seq.retired)
                throw new Error('Relay operation was already retired');
            const previous = seq.receipts[operation.sequence];
            if (previous) {
                if (previous.digest !== digest)
                    throw new Error('Relay operation payload changed');
                return clone(previous.result);
            }
            if (operation.sequence !== seq.latest + 1 || Object.keys(seq.receipts).length >= LIMIT)
                throw new Error('Relay operation sequence or capacity mismatch');
            const input = operation.input;
            let result: unknown;
            if (input.kind === 'message') {
                field(input.message, 'message', 64 * 1024);
                const target = group.members.find(m => m.id === input.targetMemberId);
                if (!target || (member.role === 'primary' ? target.role !== 'secondary' : target.id !== group.primaryMemberId))
                    throw new Error('Relay role cannot message that member');
                this.enqueueDelivery(state, group, operation.operationId, target.id, member.id, `[Collaboration ${member.role === 'primary' ? 'request' : 'report'} from member ${member.id}]\nReply using the group member ID, not a session ID.\n\n${input.message}`);
                result = { delivery: 'queued-for-relay', operationId: operation.operationId };
            }
            else if (input.kind === 'board') {
                field(input.itemId, 'board key', 128);
                if (['__proto__', 'constructor', 'prototype'].includes(input.itemId))
                    throw new Error('Reserved relay board key');
                if (member.role !== 'primary' && !['task.', 'status.', 'worklog.'].some(prefix => input.itemId === `${prefix}${member.id}` || input.itemId.startsWith(`${prefix}${member.id}.`)))
                    throw new Error('Secondary members may update only their own task records');
                const encoded = JSON.stringify(input.value);
                if (!encoded || encoded.length > 256 * 1024 || (!Object.hasOwn(group.board, input.itemId) && Object.keys(group.board).length >= 256))
                    throw new Error('Relay board limit exceeded');
                group.board[input.itemId] = { value: clone(input.value), revision: group.revision + 1, updatedBy: member.id, updatedAt: Date.now() };
                result = { applied: true, revision: group.revision + 1 };
            }
            else if (input.kind === 'putFile') {
                field(input.name, 'file name', 255);
                if (input.name.includes('/') || input.name.includes('\\') || typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64))
                    throw new Error('Invalid shared relay file');
                const data = Buffer.from(input.dataBase64, 'base64');
                if (!data.length || data.length > MAX_FILE)
                    throw new Error('Relay file size exceeded');
                const id = createHash('sha256').update(input.name).digest('hex');
                if (!group.files[id] && Object.keys(group.files).length >= 256)
                    throw new Error('Relay file count exceeded');
                const sha256 = createHash('sha256').update(data).digest('hex');
                const dir = this.path(workspaceId, operation.groupId) + '.files';
                await mkdir(dir, { recursive: true, mode: 0o700 });
                const tmp = join(dir, `${sha256}.${randomUUID()}.tmp`);
                await writeFile(tmp, data, { mode: 0o600 });
                await rename(tmp, join(dir, sha256));
                const file = { id, name: input.name, size: data.length, sha256, ...(input.contentType ? { contentType: field(input.contentType, 'content type', 255) } : {}), updatedBy: member.id };
                group.files[id] = file;
                result = { applied: true, file };
            }
            else
                throw new Error('Unsupported relay operation');
            group.revision++;
            group.updatedAt = Date.now();
            group.events.push({ operationId: operation.operationId, fromMemberId: member.id, ...(input.kind === 'message' ? { toMemberId: input.targetMemberId, text: input.message } : {}), type: input.kind, revision: group.revision, createdAt: Date.now() });
            group.events = group.events.slice(-500);
            while (Buffer.byteLength(JSON.stringify(group)) > MAX_GROUP && group.events.length)
                group.events.shift();
            if (Buffer.byteLength(JSON.stringify(group)) > MAX_GROUP)
                throw new Error('Relay shared-state capacity exceeded');
            seq.latest = operation.sequence;
            seq.receipts[operation.sequence] = { digest, result };
            await this.save(workspaceId, state);
            return clone(result);
        });
    }
    async accept(workspaceId: string, delivery: Delivery): Promise<Receipt> {
        return this.locked(workspaceId, delivery.groupId, async () => {
            const state = await this.load(workspaceId, delivery);
            if (state.phase !== 'active')
                throw new Error('Relay target membership is not active');
            const target = state.members.find(m => m.id === delivery.targetMemberId);
            if (!target || hash(delivery.target) !== hash({ serverId: target.serverId, workspaceId: target.workspaceId, sessionId: target.sessionId }))
                throw new Error('Relay delivery target mismatch');
            const { digest, ...unsigned } = delivery;
            if (digest !== hash(unsigned))
                throw new Error('Relay delivery digest mismatch');
            if (!Number.isSafeInteger(delivery.sequence) || delivery.sequence < 1)
                throw new Error('Invalid relay delivery sequence');
            const inbox = state.inbox[target.id] ??= { retired: 0, latest: 0, receipts: safeMap() };
            if (delivery.sequence <= inbox.retired)
                throw new Error('Relay delivery was already retired');
            const existing = inbox.receipts[delivery.sequence];
            if (existing) {
                if (existing.digest !== digest)
                    throw new Error('Relay delivery payload changed');
                return clone(existing.receipt);
            }
            if (delivery.sequence !== inbox.latest + 1 || Object.keys(inbox.receipts).length >= LIMIT)
                throw new Error('Relay delivery sequence or capacity mismatch');
            if (!this.deps.sessions.acceptCollaborationRelayMessage)
                throw new Error('Durable relay inbox is unavailable');
            const receipt = await this.deps.sessions.acceptCollaborationRelayMessage(target.sessionId, delivery);
            inbox.latest = delivery.sequence;
            inbox.receipts[delivery.sequence] = { digest, receipt };
            await this.save(workspaceId, state);
            return clone(receipt);
        });
    }
    async pending(workspaceId: string, scope: Scope) {
        const state = await this.load(workspaceId, scope);
        const closed = state.phase === 'ended' || state.phase === 'aborted';
        let bytes = 0;
        const take = <T>(items: T[]): T[] => {
            const batch: T[] = [];
            for (const item of items) {
                const size = Buffer.byteLength(JSON.stringify(item));
                if (batch.length >= 32 || bytes + size > 12 * 1024 * 1024)
                    break;
                bytes += size;
                batch.push(item);
            }
            return batch;
        };
        return clone({ operations: closed ? [] : take(state.operations), deliveries: closed ? [] : take(state.deliveries), operationCount: closed ? 0 : state.operations.length, deliveryCount: closed ? 0 : state.deliveries.length, retiredOperations: state.retiredOperations, retiredDeliveries: state.retiredDeliveries, phase: state.phase, groupState: state.group?.state });
    }
    async acknowledge(workspaceId: string, scope: Scope, input: {
        kind: 'operation' | 'delivery' | 'retireOperations' | 'retireDeliveries';
        memberId: string;
        sequence: number;
    }): Promise<void> {
        await this.locked(workspaceId, scope.groupId, async () => {
            const state = await this.load(workspaceId, scope);
            if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !ID.test(input.memberId))
                throw new Error('Invalid relay acknowledgment');
            if (input.kind === 'operation') {
                const retired = state.retiredOperations[input.memberId] ?? 0;
                if (input.sequence <= retired)
                    return;
                if (input.sequence !== retired + 1 || !state.operations.some(op => op.memberId === input.memberId && op.sequence === input.sequence))
                    throw new Error('Relay operation acknowledgment gap');
                state.operations = state.operations.filter(op => op.memberId !== input.memberId || op.sequence !== input.sequence);
                state.retiredOperations[input.memberId] = input.sequence;
            }
            else if (input.kind === 'delivery') {
                const retired = state.retiredDeliveries[input.memberId] ?? 0;
                if (input.sequence <= retired)
                    return;
                if (input.sequence !== retired + 1 || !state.deliveries.some(op => op.targetMemberId === input.memberId && op.sequence === input.sequence))
                    throw new Error('Relay delivery acknowledgment gap');
                state.deliveries = state.deliveries.filter(op => op.targetMemberId !== input.memberId || op.sequence !== input.sequence);
                state.retiredDeliveries[input.memberId] = input.sequence;
            }
            else {
                const map = input.kind === 'retireOperations' ? state.applied : state.inbox;
                const seq = map[input.memberId];
                if (!seq || input.sequence > seq.latest)
                    throw new Error('Relay receipt retirement exceeds durable acceptance');
                seq.retired = Math.max(seq.retired, input.sequence);
                for (const key of Object.keys(seq.receipts))
                    if (Number(key) <= seq.retired)
                        delete seq.receipts[key];
            }
            await this.save(workspaceId, state);
        });
    }
    private async sessionScope(sessionId: string) {
        const session = await this.deps.sessions.getSession(sessionId), c = session?.collaboration;
        if (!session || !c?.relay || c.relay.phase !== 'active')
            throw new Error('Session relay membership is unavailable');
        return { session, c, scope: { groupId: c.groupId, epoch: c.relay.epoch, ownerId: c.relay.ownerId } };
    }
    private validateOutgoing(state: RecordState, memberId: string, input: OperationInput): void {
        const actor = state.members.find(m => m.id === memberId);
        if (!actor || !state.group || !input || typeof input !== 'object')
            throw new Error('Relay actor is unavailable');
        if (input.kind === 'message') {
            field(input.message, 'message', 64 * 1024);
            const target = state.group.members.find(m => m.id === input.targetMemberId);
            if (!target || (actor.role === 'primary' ? target.role !== 'secondary' : target.id !== state.group.primaryMemberId))
                throw new Error('Relay role cannot message that member');
        }
        else if (input.kind === 'board') {
            field(input.itemId, 'board key', 128);
            if (['__proto__', 'constructor', 'prototype'].includes(input.itemId))
                throw new Error('Reserved relay board key');
            if (actor.role !== 'primary' && !['task.', 'status.', 'worklog.'].some(prefix => input.itemId === `${prefix}${memberId}` || input.itemId.startsWith(`${prefix}${memberId}.`)))
                throw new Error('Secondary members may update only their own task records');
            const encoded = JSON.stringify(input.value);
            if (!encoded || encoded.length > 256 * 1024)
                throw new Error('Relay board limit exceeded');
        }
        else if (input.kind === 'putFile') {
            field(input.name, 'file name', 255);
            if (input.name.includes('/') || input.name.includes('\\') || typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64))
                throw new Error('Invalid shared relay file');
            if (!Buffer.from(input.dataBase64, 'base64').length)
                throw new Error('Empty shared relay file');
            if (input.contentType !== undefined)
                field(input.contentType, 'content type', 255);
        }
        else
            throw new Error('Unsupported relay operation');
    }
    async perform(sessionId: string, input: OperationInput, options?: {
        waitForRelay?: boolean;
    }): Promise<unknown> {
        const { session, c, scope } = await this.sessionScope(sessionId);
        const operation = await this.locked(session.workspaceId, scope.groupId, async () => {
            const state = await this.load(session.workspaceId, scope);
            if (state.phase !== 'active' || state.operations.length >= LIMIT)
                throw new Error('Relay operation backlog is unavailable');
            this.validateOutgoing(state, c.memberId, input);
            const sequence = (state.operationSequence[c.memberId] ?? 0) + 1;
            state.operationSequence[c.memberId] = sequence;
            const op: Operation = { ...scope, operationId: randomUUID(), memberId: c.memberId, sequence, input: clone(input) };
            if (Buffer.byteLength(JSON.stringify(state.operations)) + Buffer.byteLength(JSON.stringify(op)) > 16 * 1024 * 1024)
                throw new Error('Relay pending data limit exceeded');
            state.operations.push(op);
            await this.save(session.workspaceId, state);
            return op;
        });
        const binding = this.bindings.get(this.key(session.workspaceId, scope.groupId));
        if (options?.waitForRelay !== false && binding && binding.expiresAt > Date.now() && (binding.alive?.() ?? true)) {
            try {
                const result = await binding.invoke({ kind: 'operation', operation });
                await this.acknowledge(session.workspaceId, scope, { kind: 'operation', memberId: c.memberId, sequence: operation.sequence });
                return result;
            }
            catch { /* Durable outbox remains pending; never replay an unknown accepted operation with a new ID. */ }
        }
        return { delivery: 'queued-for-relay', operationId: operation.operationId, message: 'Saved for relay. Keep the Electron app running; do not repeat this operation.' };
    }
    async readForSession(sessionId: string, fileId?: string): Promise<unknown> {
        const { session, c, scope } = await this.sessionScope(sessionId);
        const binding = this.bindings.get(this.key(session.workspaceId, scope.groupId));
        if (!binding || binding.expiresAt < Date.now() || !(binding.alive?.() ?? true)) {
            if (fileId)
                throw new Error('Relay is offline; shared file cannot be fetched');
            const state = await this.load(session.workspaceId, scope);
            return { ...state.group, relayStatus: 'offline', stale: true };
        }
        const result = await binding.invoke({ kind: 'read', ...scope, memberId: c.memberId, ...(fileId ? { fileId } : {}) });
        if (!fileId) {
            const group = result as Group;
            this.validateGroup(group, scope);
            await this.locked(session.workspaceId, scope.groupId, async () => {
                const state = await this.load(session.workspaceId, scope);
                if (state.phase === 'active' && (!state.group || group.revision >= state.group.revision)) {
                    state.group = clone(group);
                    await this.save(session.workspaceId, state);
                }
            });
        }
        return result;
    }
    async cleanup() { await Promise.allSettled(this.queues.values()); this.bindings.clear(); this.queues.clear(); }
}

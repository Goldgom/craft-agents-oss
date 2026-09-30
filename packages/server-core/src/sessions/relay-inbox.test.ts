import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '@craft-agent/shared/sessions';
import { messageToStored, storedToMessage, type Message } from '@craft-agent/core/types';
import type { CollaborationRelayDelivery } from '@craft-agent/shared/protocol';
import { SessionManager } from './SessionManager';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0))
    await action(); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'relay-production-inbox-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stored = await createSession(root, { name: 'Owned relay inbox' });
    const unsigned = { groupId: `collab_${randomUUID()}`, epoch: randomUUID(), ownerId: randomUUID(), operationId: randomUUID(), sequence: 1, targetMemberId: 'secondary_1', sourceMemberId: 'primary', target: { serverId: 'owned-server', workspaceId: 'owned-workspace', sessionId: stored.id }, message: 'Owned dummy task' };
    const delivery: CollaborationRelayDelivery = { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') };
    const c = { groupId: delivery.groupId, memberId: delivery.targetMemberId, role: 'secondary', coordinatorWorkspaceId: 'coordinator', relay: { protocolVersion: 1, epoch: delivery.epoch, ownerId: delivery.ownerId, serverId: 'owned-server', phase: 'active', coordinator: { serverId: 'coordinator', workspaceId: 'coordinator' }, creationOperationId: 'create' } };
    function instance(busy = false) {
        const managed: any = { id: stored.id, workspace: { id: 'owned-workspace', rootPath: root }, collaboration: c, isProcessing: busy, messages: [] as Message[], messageQueue: [], messagesLoaded: false };
        const manager: any = Object.create(SessionManager.prototype);
        Object.assign(manager, { sessions: new Map([[stored.id, managed]]), relayMessageQueues: new Map(), relayStartScheduled: new Set(), monotonic: () => Date.now(), persistSession: () => { } });
        let starts = 0, failFlush = false, gate: Promise<void> | undefined;
        manager.ensureMessagesLoaded = async () => { if (managed.messagesLoaded)
            return; managed.messages = (loadSession(root, stored.id)?.messages ?? []).map(storedToMessage); managed.messageQueue = managed.messages.filter((m: Message) => m.isQueued).map((m: Message) => ({ message: m.content, messageId: m.id, options: { collaborationDispatch: true } })); managed.messagesLoaded = true; };
        manager.flushSession = async () => { await gate; if (failFlush) {
            failFlush = false;
            throw new Error('Owned disk interruption');
        } ; await saveSession({ ...stored, collaboration: c as any, messages: managed.messages.map(messageToStored), tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } }); };
        manager.sendEvent = () => { };
        manager.processNextQueuedMessage = () => { starts++; const next = managed.messageQueue.shift(); if (next)
            managed.messages.find((m: Message) => m.id === next.messageId)!.isQueued = false; };
        return { manager: manager as SessionManager, managed, starts: () => starts, fail: () => { failFlush = true; }, block: (value: Promise<void>) => { gate = value; } };
    }
    return { root, stored, delivery, instance };
}
test('production inbox atomically persists identity with message and concurrent delivery appends once', async () => {
    const f = await fixture(), i = f.instance();
    const receipts = await Promise.all(Array.from({ length: 12 }, () => i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery)));
    await Bun.sleep(20);
    expect(new Set(receipts.map(r => r.messageId)).size).toBe(1);
    expect(i.managed.messages).toHaveLength(1);
    expect(i.starts()).toBe(1);
    const disk = loadSession(f.root, f.stored.id)!;
    expect(disk.messages).toHaveLength(1);
    expect(disk.messages[0]!.relayDelivery?.digest).toBe(f.delivery.digest);
});
test('production inbox cannot acknowledge or start before durable flush; retry after disk failure starts once', async () => {
    const f = await fixture(), i = f.instance();
    let release!: () => void;
    i.block(new Promise<void>(resolve => { release = resolve; }));
    let acknowledged = false;
    const pending = i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery).then(result => { acknowledged = true; return result; });
    await Bun.sleep(20);
    expect(acknowledged).toBe(false);
    expect(i.starts()).toBe(0);
    release();
    const receipt = await pending;
    expect(loadSession(f.root, f.stored.id)!.messages[0]!.id).toBe(receipt.messageId);
    const other = await fixture(), interrupted = other.instance();
    interrupted.fail();
    await expect(interrupted.manager.acceptCollaborationRelayMessage(other.stored.id, other.delivery)).rejects.toThrow('Owned disk interruption');
    expect(interrupted.starts()).toBe(0);
    const recovered = await interrupted.manager.acceptCollaborationRelayMessage(other.stored.id, other.delivery);
    await Bun.sleep(20);
    expect(interrupted.starts()).toBe(1);
    expect(loadSession(other.root, other.stored.id)!.messages.map(m => m.id)).toEqual([recovered.messageId]);
});
test('new production manager reconciles message persisted before receipt without appending another task', async () => {
    const f = await fixture(), before = f.instance(true);
    const first = await before.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
    const after = f.instance(true);
    const recovered = await after.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
    expect(recovered.messageId).toBe(first.messageId);
    expect(after.managed.messages).toHaveLength(1);
    expect(after.managed.messageQueue).toHaveLength(1);
    expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1);
    await expect(after.manager.acceptCollaborationRelayMessage(f.stored.id, { ...f.delivery, digest: 'changed' })).rejects.toThrow('payload changed');
    await expect(after.manager.acceptCollaborationRelayMessage(f.stored.id, { ...f.delivery, epoch: randomUUID() })).rejects.toThrow('membership is stale');
});

test('a previous turn ending during flush cannot run an unpersisted relay message', async () => {
    const f = await fixture(), i = f.instance(true);
    let release!: () => void;
    i.block(new Promise<void>(resolve => { release = resolve; }));
    i.fail();
    const pending = i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
    void pending.catch(() => {});
    await Bun.sleep(10);
    expect(i.managed.messages).toHaveLength(1);
    expect(i.managed.messageQueue).toHaveLength(0);
    // The previous turn's ordinary queue drain sees no runnable message yet.
    i.managed.isProcessing = false;
    if (i.managed.messageQueue.length) (i.manager as any).processNextQueuedMessage(f.stored.id);
    expect(i.starts()).toBe(0);
    release();
    await expect(pending).rejects.toThrow('Owned disk interruption');
    expect(i.managed.messageQueue).toHaveLength(0);
    expect(i.starts()).toBe(0);
    await i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
    await Bun.sleep(20);
    expect(i.starts()).toBe(1);
    expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('real production queue write failure prevents relay ACK/start and permits a dirty retry', async () => {
    const { chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { getSessionFilePath, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions');
    const f = await fixture(), i = f.instance();
    delete (i.manager as any).persistSession;
    delete (i.manager as any).flushSession;
    i.managed.messagesLoaded = true;
    i.managed.name = f.stored.name;
    const path = getSessionFilePath(f.root, f.stored.id);
    try {
        await chmod(dirname(path), 0o500);
        await expect(i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery)).rejects.toThrow();
        await Bun.sleep(20);
        expect(i.starts()).toBe(0);
        expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(0);
        expect(sessionPersistenceQueue.hasPending(f.stored.id)).toBe(true);
        await chmod(dirname(path), 0o700);
        await i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
        await Bun.sleep(20);
        expect(i.starts()).toBe(1);
        expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1);
    } finally {
        await chmod(dirname(path), 0o700);
        sessionPersistenceQueue.cancel(f.stored.id);
    }
});

test('real durable inbox propagates snapshot construction errors rather than acknowledging an empty flush', async () => {
    const { sessionPersistenceQueue } = await import('@craft-agent/shared/sessions');
    const f = await fixture(), i = f.instance();
    delete (i.manager as any).persistSession;
    delete (i.manager as any).flushSession;
    i.managed.messagesLoaded = true;
    i.managed.messages.filter = () => { throw new Error('Owned snapshot construction failure'); };
    try {
        await expect(i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery)).rejects.toThrow('Owned snapshot construction failure');
        expect(i.starts()).toBe(0);
        expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(0);
        delete i.managed.messages.filter;
        await i.manager.acceptCollaborationRelayMessage(f.stored.id, f.delivery);
        await Bun.sleep(20);
        expect(i.starts()).toBe(1);
        expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1);
    } finally { sessionPersistenceQueue.cancel(f.stored.id); }
});

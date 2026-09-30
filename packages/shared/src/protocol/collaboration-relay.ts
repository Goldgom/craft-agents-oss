/** Cross-server collaboration wire contracts. Never put credentials or URLs here. */
export const COLLABORATION_RELAY_PROTOCOL = 1 as const;
export const COLLABORATION_RELAY_CAPABILITY = 'collaborationRelay:forward' as const;
export type CollaborationServerRef = {
    kind: 'local';
} | {
    kind: 'saved';
    profileId: string;
};
export interface CollaborationRelaySelectionBase {
    server: CollaborationServerRef;
    workspaceId: string;
    name?: string;
}
export type CollaborationRelaySelection = CollaborationRelaySelectionBase & ({
    sessionId: string;
    createNew?: false;
} | {
    createNew: true;
    sessionId?: never;
});
export interface CollaborationRelayCandidate {
    server: CollaborationServerRef;
    workspaceId: string;
    sessionId: string;
    name?: string;
    unavailableReason?: string;
}
export type CollaborationRelayCreationState = 'preparing' | 'committing' | 'active' | 'aborting' | 'aborted' | 'ended' | 'paused';
export interface CollaborationRelayCreateResult {
    groupId: string;
    operationId: string;
    state: CollaborationRelayCreationState;
    activationStatus: 'started' | 'queued' | 'failed';
    memberCount: number;
    warnings?: Array<{
        code: string;
        message: string;
    }>;
}
export interface CollaborationPendingCreation extends CollaborationRelayCreateResult {
    secondaries: CollaborationRelaySelection[];
}
export interface CollaborationSetupContext {
    contextId: string;
    primary: {
        server: CollaborationServerRef;
        serverName: string;
        workspaceId: string;
        workspaceName: string;
        sessionId: string;
        sessionName: string;
    };
    servers: Array<{
        server: CollaborationServerRef;
        name: string;
        credentialAvailable: boolean;
    }>;
    relayProtocolVersion: 1;
    requiresRunningDesktop: true;
    pendingCreations: CollaborationPendingCreation[];
}
export interface CollaborationRelayCreateInput {
    contextId: string;
    operationId: string;
    secondaries: CollaborationRelaySelection[];
}
export type CollaborationRelayStatusLookup = {
    groupId: string;
} | {
    operationId: string;
};
export interface CollaborationRelayStatus extends CollaborationRelayCreateResult {
    /** Last-known shared task snapshot; freshness is given by lastSyncedAt. */
    group?: CollaborationRelayGroup;
    canEnd: boolean;
    requiresRunningDesktop: true;
    lastSyncedAt?: number;
    pendingDeliveries: number;
    pendingOperations: number;
}
export interface CollaborationRelayAddress {
    serverId: string;
    workspaceId: string;
    sessionId: string;
}
export interface CollaborationRelayMember extends CollaborationRelayAddress {
    id: string;
    role: 'primary' | 'secondary';
    name?: string;
}
export interface CollaborationRelayMembership {
    protocolVersion: 1;
    epoch: string;
    serverId: string;
    coordinator: {
        serverId: string;
        workspaceId: string;
    };
    ownerId: string;
    phase: 'prepared' | 'active' | 'ended';
    creationOperationId: string;
    createdForOperation?: boolean;
    createdSessionFingerprint?: string;
}
export interface CollaborationRelayInfo {
    protocolVersion: 1;
    serverId: string;
    features: Array<'durable-inbox-v1' | 'prepared-members-v1' | 'member-routing-v1'>;
    limits: {
        members: number;
        outstanding: number;
        fileBytes: number;
    };
}
export interface CollaborationRelayPrepareInput {
    groupId: string;
    epoch: string;
    ownerId: string;
    operationId: string;
    coordinator: {
        serverId: string;
        workspaceId: string;
    };
    members: Array<{
        id: string;
        role: 'primary' | 'secondary';
        name?: string;
    } & ({
        sessionId: string;
        createNew?: false;
    } | {
        createNew: true;
        sessionId?: never;
    })>;
}
export interface CollaborationRelayScope {
    groupId: string;
    epoch: string;
    ownerId: string;
}
export interface CollaborationRelayBoardItem {
    value: unknown;
    revision: number;
    updatedBy: string;
    updatedAt: number;
}
export interface CollaborationRelayFile {
    id: string;
    name: string;
    size: number;
    sha256: string;
    contentType?: string;
    updatedBy: string;
}
export interface CollaborationRelayGroup extends CollaborationRelayScope {
    version: 2;
    revision: number;
    state: 'committing' | 'active' | 'ended';
    coordinator: {
        serverId: string;
        workspaceId: string;
    };
    primaryMemberId: string;
    members: CollaborationRelayMember[];
    board: Record<string, CollaborationRelayBoardItem>;
    files: Record<string, CollaborationRelayFile>;
    events: Array<{
        operationId: string;
        fromMemberId: string;
        toMemberId?: string;
        type: string;
        text?: string;
        createdAt: number;
        revision: number;
    }>;
    createdAt: number;
    updatedAt: number;
}
export type CollaborationRelayOperationInput = {
    kind: 'message';
    targetMemberId: string;
    message: string;
} | {
    kind: 'board';
    itemId: string;
    value: unknown;
} | {
    kind: 'putFile';
    name: string;
    dataBase64: string;
    contentType?: string;
};
export interface CollaborationRelayOperation extends CollaborationRelayScope {
    operationId: string;
    memberId: string;
    sequence: number;
    input: CollaborationRelayOperationInput;
}
export interface CollaborationRelayDelivery extends CollaborationRelayScope {
    operationId: string;
    sequence: number;
    sourceMemberId: string;
    targetMemberId: string;
    target: CollaborationRelayAddress;
    message: string;
    hidden?: boolean;
    digest: string;
}
export interface CollaborationRelayReceipt {
    operationId: string;
    sequence: number;
    messageId: string;
    delivery: 'delivered' | 'queued';
    targetBusy: boolean;
}
export type CollaborationRelayForward = {
    kind: 'operation';
    operation: CollaborationRelayOperation;
} | ({
    kind: 'read';
    memberId: string;
    fileId?: string;
} & CollaborationRelayScope);
/** All verbs are fixed domain operations; no arbitrary target/RPC forwarding. */
export const COLLABORATION_RELAY_RPC = {
    INFO: 'collaborationRelay:info',
    PREPARE: 'collaborationRelay:prepare',
    COMMIT: 'collaborationRelay:commit',
    ABORT: 'collaborationRelay:abort',
    BIND: 'collaborationRelay:bind',
    GROUP: 'collaborationRelay:group',
    APPLY: 'collaborationRelay:apply',
    ACCEPT: 'collaborationRelay:accept',
    PENDING: 'collaborationRelay:pending',
    ACK: 'collaborationRelay:ack',
    END: 'collaborationRelay:end',
} as const;

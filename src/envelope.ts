/**
 * Envelope construction for the Mengpo v1 command surface.
 *
 * Scope values are client claims, never authorization evidence: the service
 * compares them against the trusted identity. The extension therefore only ever
 * declares what it was told by the service or by pi itself.
 */

export type ScopeType = "user-global" | "session";

export interface EnvelopeInput {
	tenantId: string;
	userId: string;
	principalId: string;
	principalType?: "user" | "agent";
	scopeType: ScopeType;
	sessionId?: string;
	requestId: string;
	idempotencyKey: string;
	payload: unknown;
	memoryHint?: MemoryHint;
	visibility?: "private" | "tenant";
}

export interface MemoryHint {
	mode?: "auto" | "focus" | "diverge";
	topics?: string[];
	memoryIds?: string[];
	allowCandidates?: boolean;
}

export interface Envelope {
	version: "v1";
	request_id: string;
	idempotency_key: string;
	principal: { type: string; id: string };
	scope: { tenant_id: string; user_id: string; type: string; session_id?: string };
	privacy: { visibility: string };
	payload: unknown;
	memory_hint?: Record<string, unknown>;
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
	const scope: Envelope["scope"] = {
		tenant_id: input.tenantId,
		user_id: input.userId,
		type: input.scopeType,
	};
	// The session identifier is what makes session-scoped memories reachable.
	// Omitting it silently narrows recall to user-global memories, so it is
	// always carried when the scope is a session.
	if (input.scopeType === "session" && input.sessionId) {
		scope.session_id = input.sessionId;
	}
	const envelope: Envelope = {
		version: "v1",
		request_id: input.requestId,
		idempotency_key: input.idempotencyKey,
		principal: { type: input.principalType ?? "user", id: input.principalId },
		scope,
		privacy: { visibility: input.visibility ?? "private" },
		payload: input.payload,
	};
	if (input.memoryHint) {
		const hint: Record<string, unknown> = {};
		if (input.memoryHint.mode) {
			hint.mode = input.memoryHint.mode;
		}
		if (input.memoryHint.topics?.length) {
			hint.topics = input.memoryHint.topics;
		}
		if (input.memoryHint.memoryIds?.length) {
			hint.memory_ids = input.memoryHint.memoryIds;
		}
		if (input.memoryHint.allowCandidates !== undefined) {
			hint.allow_candidates = input.memoryHint.allowCandidates;
		}
		if (Object.keys(hint).length > 0) {
			envelope.memory_hint = hint;
		}
	}
	return envelope;
}

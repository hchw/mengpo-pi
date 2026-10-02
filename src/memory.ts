/**
 * Memory bridge: the part of the adapter that is independent of pi.
 *
 * It owns the session binding, the scenario decision, the recall/injection
 * handshake and the (background) reporting, and it is written so that every
 * failure degrades to "no memory" instead of reaching the session.
 */

import { CircuitBreaker } from "./breaker.ts";
import {
	MemoryClient,
	type ProjectionResult,
	type SessionContext,
} from "./client.ts";
import type { MemoryHint, ScopeType } from "./envelope.ts";
import { buildScenarioSignals, decideRecall, type RecallDecision, type ScenarioInput } from "./recall.ts";
import { deriveTrace, EVENT_TYPES, toolResultType, type Trace } from "./trace.ts";

export const INJECTION_TAG = "mengpo_memory";
export const INJECTION_MARKER = "<mengpo_memory>";

export interface SerializedEvent {
	scopeType: ScopeType;
	sessionId?: string;
	sourceType: "user" | "agent" | "tool" | "workflow" | "gateway";
	messageType: string;
	sequence?: number;
	/** pi session entry id; travels as the event's `source_event_id`. */
	entryId?: string;
	/** pi parent session entry id; kept in the event payload for correlation. */
	parentEntryId?: string;
	trace: Trace;
	payload: Record<string, unknown>;
	text?: string;
	idempotencyKey: string;
}

export interface RecallOutcome {
	decided: RecallDecision;
	injection?: string;
	projectionId?: string;
	mode?: string;
	itemCount: number;
}

export interface BridgeDeps {
	client: MemoryClient;
	breaker?: CircuitBreaker;
	/** Reports a degraded operation without ever throwing. */
	onDegrade?: (reason: string, error?: unknown) => void;
}

/** The bridge's view of a session: identifiers and recent activity. */
export interface SessionNote {
	turnId?: string;
	entryId?: string;
	parentEntryId?: string;
	/** Explicit ordering value; falls back to deriving one from the entry id. */
	sequence?: number;
}

export class MemoryBridge {
	private readonly client: MemoryClient;
	private readonly breaker: CircuitBreaker;
	private readonly onDegrade: (reason: string, error?: unknown) => void;
	private boundSessionId = "";
	private currentTurnId = "";
	private lastInjectionTurnId: string | undefined;
	private currentProjectionId: string | undefined;
	private injectedMemoryIds: string[] = [];
	private consecutiveFailures = 0;
	private newEvidenceSinceInjection = false;
	private recorded: string[] = [];

	constructor(deps: BridgeDeps) {
		this.client = deps.client;
		this.breaker = deps.breaker ?? new CircuitBreaker();
		this.onDegrade = deps.onDegrade ?? (() => {});
	}

	get sessionId(): string {
		return this.boundSessionId;
	}

	get projectionId(): string | undefined {
		return this.currentProjectionId;
	}

	get failures(): number {
		return this.consecutiveFailures;
	}

	status(): string {
		if (this.boundSessionId === "") {
			return "mengpo: not connected";
		}
		const injected = this.lastInjectionTurnId === this.currentTurnId && this.injectedMemoryIds.length > 0;
		return `mengpo: connected session=${this.boundSessionId} injected=${injected ? `${this.injectedMemoryIds.length} memor${this.injectedMemoryIds.length === 1 ? "y" : "ies"}` : "none"}`;
	}

	/** bind establishes the session binding. Failure leaves the session usable. */
	async bind(externalId: string, title: string): Promise<boolean> {
		if (!this.breaker.allows()) {
			return false;
		}
		try {
			const sessionId = await this.client.bindSession(externalId, title);
			this.boundSessionId = sessionId;
			this.breaker.recordSuccess();
			return true;
		} catch (error) {
			this.breaker.recordFailure();
			this.onDegrade("session binding failed", error);
			return false;
		}
	}

	/** beginTurn records the turn identity used to attribute later events. */
	beginTurn(note: SessionNote): void {
		this.currentTurnId = note.turnId ?? this.currentTurnId;
		this.recorded = [];
	}

	/** noteNewEvidence marks that something changed since the last injection. */
	noteNewEvidence(): void {
		this.newEvidenceSinceInjection = true;
	}

	/**
	 * recall decides whether this turn should recall, and returns the injection
	 * text when it should. A turn that skips recall leaves the prompt untouched.
	 */
	async recall(input: { hasNewUserInput: boolean; taskSwitched?: boolean; userRequestedRecall?: boolean; scenario?: ScenarioInput; query: string }): Promise<RecallOutcome> {
		const decided = decideRecall({
			hasNewUserInput: input.hasNewUserInput,
			taskSwitched: input.taskSwitched ?? false,
			consecutiveFailures: this.consecutiveFailures,
			userRequestedRecall: input.userRequestedRecall ?? false,
			lastInjectionTurnId: this.lastInjectionTurnId,
			currentTurnId: this.currentTurnId,
			newEvidenceSinceInjection: this.newEvidenceSinceInjection,
		});
		if (!decided.recall) {
			return { decided, itemCount: 0 };
		}
		if (this.boundSessionId === "") {
			return { decided, itemCount: 0 };
		}
		if (!this.breaker.allows()) {
			return { decided, itemCount: 0 };
		}
		try {
			const scenario = buildScenarioSignals({
				consecutiveFailures: this.consecutiveFailures,
				...input.scenario,
			});
			const projection = await this.client.project({
				scopeType: "session",
				sessionId: this.boundSessionId,
				idempotencyKey: `project:${this.currentTurnId || "turn"}`,
				query: input.query,
				memoryHint: { mode: "auto" } satisfies MemoryHint,
				scenario: scenario as Record<string, unknown>,
			});
			this.breaker.recordSuccess();
			this.applyProjection(projection);
			return {
				decided,
				injection: projection.items.length > 0 ? renderInjection(projection.items.map((item) => item.text)) : undefined,
				projectionId: projection.projectionId,
				mode: projection.mode,
				itemCount: projection.items.length,
			};
		} catch (error) {
			this.breaker.recordFailure();
			this.onDegrade("recall failed", error);
			return { decided, itemCount: 0 };
		}
	}

	private applyProjection(projection: ProjectionResult): void {
		this.lastInjectionTurnId = this.currentTurnId;
		this.currentProjectionId = projection.projectionId;
		this.injectedMemoryIds = projection.items.map((item) => item.memoryId).filter((id) => id !== "");
		this.newEvidenceSinceInjection = false;
	}

	/**
	 * observe reports one event in the background. It never blocks the caller
	 * and never throws: reporting is a side channel.
	 */
	async observe(event: SerializedEvent): Promise<void> {
		if (this.boundSessionId === "" || !this.breaker.allows()) {
			return;
		}
		if (this.recorded.includes(event.idempotencyKey)) {
			return;
		}
		this.recorded.push(event.idempotencyKey);
		try {
			// The observe envelope carries event data in a nested `payload` field;
			// only the contract fields (source, type, order, parent, trace) live at
			// the top level. Spreading event data there makes the strict decoder
			// reject the whole observation as unknown fields.
			const payload: Record<string, unknown> = {
				source_type: event.sourceType,
				message_type: event.messageType,
			};
			if (event.sequence !== undefined) {
				payload.sequence = event.sequence;
			}
			if (event.entryId) {
				// `source_event_id` is text and carries the pi entry identity.
				payload.source_event_id = event.entryId;
			}
			if (event.text) {
				payload.text = event.text;
			}
			const data: Record<string, unknown> = { ...event.payload };
			// `parent_event_id` is a server-side event reference (a uuid), not a pi
			// entry id; sending an entry id there makes the service reject the
			// observation. The pi-side causal link is kept in the payload instead.
			if (event.parentEntryId) {
				data.parent_entry_id = event.parentEntryId;
			}
			// Mark what was injected so the service can tell model output apart
			// from memory it handed back; without this the memory would be
			// re-observed and reinforce itself.
			if (this.injectedMemoryIds.length > 0) {
				data.mengpo_injected_memory_ids = [...this.injectedMemoryIds];
			}
			if (Object.keys(data).length > 0) {
				payload.payload = data;
			}
			if (Object.keys(event.trace).length > 0) {
				payload.trace = event.trace;
			}
			await this.client.observe({
				scopeType: event.scopeType,
				sessionId: event.sessionId,
				idempotencyKey: event.idempotencyKey,
				payload,
			});
			this.breaker.recordSuccess();
		} catch (error) {
			this.breaker.recordFailure();
			this.onDegrade("observation report failed", error);
		}
	}

	/** reportToolResult reports a tool outcome, declaring failure by type. */
	async reportToolResult(input: {
		toolCallId: string;
		isError: boolean;
		note: SessionNote;
		summary: string;
		attemptId?: string;
	}): Promise<void> {
		if (input.isError) {
			this.consecutiveFailures += 1;
			this.noteNewEvidence();
		} else {
			this.consecutiveFailures = 0;
		}
		await this.observe({
			scopeType: "session",
			sessionId: this.boundSessionId,
			sourceType: "tool",
			messageType: toolResultType(input.isError),
			sequence: input.note.sequence ?? sequenceOf(input.note.entryId),
			entryId: input.note.entryId,
			parentEntryId: input.note.parentEntryId,
			trace: deriveTrace({
				taskId: input.note.turnId,
				attemptId: input.attemptId,
				projectionId: this.currentProjectionId,
				toolResultId: input.toolCallId,
			}),
			payload: { tool_call_id: input.toolCallId, outcome: input.isError ? "error" : "ok" },
			text: truncate(input.summary, 2000),
			idempotencyKey: `tool:${input.toolCallId}`,
		});
	}

	/** reportTurnOutcome reports the end of a turn and its outcome identity. */
	async reportTurnOutcome(input: { note: SessionNote; outcomeId: string; summary: string; failed: boolean; lastToolCallId?: string }): Promise<void> {
		await this.observe({
			scopeType: "session",
			sessionId: this.boundSessionId,
			sourceType: "agent",
			messageType: EVENT_TYPES.turnOutcome,
			sequence: input.note.sequence ?? sequenceOf(input.note.entryId),
			entryId: input.note.entryId,
			parentEntryId: input.note.parentEntryId,
			trace: deriveTrace({
				taskId: input.note.turnId,
				projectionId: this.currentProjectionId,
				toolResultId: input.lastToolCallId,
				outcomeId: input.outcomeId,
			}),
			payload: { outcome: input.failed ? "failed" : "completed" },
			text: truncate(input.summary, 4000),
			idempotencyKey: `turn:${input.note.entryId || input.outcomeId}`,
		});
	}

	/** remember records an explicit memory instruction. */
	async remember(text: string, idempotencyKey: string): Promise<void> {
		await this.observe({
			scopeType: "user-global",
			sourceType: "user",
			messageType: EVENT_TYPES.userRemember,
			trace: deriveTrace({ taskId: this.currentTurnId }),
			payload: { remember: true },
			text,
			idempotencyKey,
		});
	}

	/** forget records an explicit forgetting instruction. */
	async forget(text: string, idempotencyKey: string): Promise<void> {
		await this.observe({
			scopeType: "user-global",
			sourceType: "user",
			messageType: EVENT_TYPES.userForget,
			trace: deriveTrace({ taskId: this.currentTurnId }),
			payload: { forget: true },
			text,
			idempotencyKey,
		});
	}

	/**
	 * feedback returns a correction or explicit signal for one memory. It is
	 * only sent when the memory identity is actually known: a fabricated target
	 * would be worse than no feedback at all.
	 */
	async feedback(memoryId: string, type: string, reason: string, idempotencyKey: string): Promise<boolean> {
		if (this.boundSessionId === "" || memoryId.trim() === "" || !this.breaker.allows()) {
			return false;
		}
		try {
			await this.client.feedback({
				scopeType: "session",
				sessionId: this.boundSessionId,
				idempotencyKey,
				memoryId: memoryId.trim(),
				type,
				reason,
			});
			this.breaker.recordSuccess();
			return true;
		} catch (error) {
			this.breaker.recordFailure();
			this.onDegrade("feedback failed", error);
			return false;
		}
	}

	/** recallNow serves the explicit, model-initiated recall tool. */
	async recallNow(query: string, idempotencyKey: string): Promise<ProjectionResult | undefined> {
		if (this.boundSessionId === "" || !this.breaker.allows()) {
			return undefined;
		}
		try {
			const projection = await this.client.project({
				scopeType: "session",
				sessionId: this.boundSessionId,
				idempotencyKey,
				query,
				memoryHint: { mode: "auto" },
			});
			this.breaker.recordSuccess();
			return projection;
		} catch (error) {
			this.breaker.recordFailure();
			this.onDegrade("explicit recall failed", error);
			return undefined;
		}
	}

	/** describeContext is used by the status command without any network call. */
	describeContext(): SessionContext | undefined {
		return this.client.tenantContext;
	}
}

/** renderInjection wraps memories so the transcript can tell them apart later. */
export function renderInjection(texts: string[]): string {
	const lines = texts.map((text) => `- ${text.replace(/\s+/g, " ").trim()}`);
	return `${INJECTION_MARKER}\n${lines.join("\n")}\n</mengpo_memory>`;
}

/** sequenceOf derives a stable ordering value from a pi entry identifier. */
export function sequenceOf(entryId: string | undefined): number | undefined {
	if (!entryId) {
		return undefined;
	}
	const parsed = Number.parseInt(entryId.slice(0, 8), 16);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function truncate(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}…`;
}

export type { RecallDecision, ScenarioInput };

/**
 * Runtime trace derivation.
 *
 * Every identifier comes from something pi already knows. When an identifier has
 * no native source it is omitted: a placeholder would buy a higher attribution
 * level at the cost of a link that is not real, which is exactly what the
 * service refuses to fabricate on its side.
 */

export interface Trace {
	task_id?: string;
	attempt_id?: string;
	projection_id?: string;
	used_memory_ids?: string[];
	tool_result_id?: string;
	outcome_id?: string;
}

export interface TraceInput {
	/** Identity of the unit of work, e.g. the turn or user request entry. */
	taskId?: string;
	/** Only set when pi reports a genuine retry of the same attempt. */
	attemptId?: string;
	/** Identity of the projection whose memories this turn received. */
	projectionId?: string;
	/** pi's identifier for the tool call this event reports. */
	toolResultId?: string;
	/** Identity of the outcome this event belongs to. */
	outcomeId?: string;
}

/** deriveTrace builds a trace containing only identifiers that actually exist. */
export function deriveTrace(input: TraceInput): Trace {
	const trace: Trace = {};
	assign(trace, "task_id", input.taskId);
	assign(trace, "attempt_id", input.attemptId);
	assign(trace, "projection_id", input.projectionId);
	assign(trace, "tool_result_id", input.toolResultId);
	assign(trace, "outcome_id", input.outcomeId);
	return trace;
}

export function isEmptyTrace(trace: Trace): boolean {
	return Object.keys(trace).length === 0;
}

/**
 * stripProjection removes the projection reference. It is used when a server
 * rejects trace fields: the observation still has value without them, and a
 * failing reporting path must not stay broken forever.
 */
export function stripProjection(trace: Trace): Trace {
	const copy: Trace = { ...trace };
	delete copy.projection_id;
	return copy;
}

function assign(target: Trace, key: keyof Trace, value: string | undefined): void {
	if (value === undefined) {
		return;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return;
	}
	(target as Record<string, string>)[key] = trimmed;
}

/** Event types the extension declares. They are the contract, not magic fields. */
export const EVENT_TYPES = {
	toolResult: "tool.result",
	toolFailure: "tool.failure",
	turnOutcome: "turn.outcome",
	userCorrection: "user_correction",
	userRemember: "user_remember",
	userForget: "user_forget",
	contextCompaction: "context.compaction",
	contextBranchSummary: "context.branch_summary",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** Classify a tool result so failure is expressed by type, not by payload. */
export function toolResultType(failed: boolean): EventType {
	return failed ? EVENT_TYPES.toolFailure : EVENT_TYPES.toolResult;
}

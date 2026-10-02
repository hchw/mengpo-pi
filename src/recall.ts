/**
 * Scenario-driven recall.
 *
 * Recalling on every model request is not only wasteful, it actively hurts: each
 * turn would inject different content and invalidate pi's cached prompt prefix.
 * The client therefore decides *whether* to recall, and never *how deep* — depth
 * and focus/divergence belong to the service, which can see conflicts and
 * evidence gaps that the client cannot.
 */

export type RecallTrigger =
	| "new-user-request"
	| "task-switch"
	| "repeated-failures"
	| "explicit-request"
	| "safe-default";

export type RecallDecision =
	| { recall: true; trigger: RecallTrigger; reason: string }
	| { recall: false; reason: string };

export interface RecallInput {
	/** A user supplied this turn's input (as opposed to a tool-driven turn). */
	hasNewUserInput: boolean;
	/** The working context moved to a different task. */
	taskSwitched: boolean;
	/** Consecutive failed attempts observed in this session. */
	consecutiveFailures: number;
	/** The user explicitly asked to revisit earlier experience. */
	userRequestedRecall: boolean;
	/** The turn that last received injected memories, if any. */
	lastInjectionTurnId?: string;
	/** The turn currently starting. */
	currentTurnId?: string;
	/** Evidence arrived since the last injection. */
	newEvidenceSinceInjection: boolean;
	/** Set when the decision inputs could not be established. */
	inputsUnavailable?: boolean;
}

export const REPEATED_FAILURE_THRESHOLD = 2;

/**
 * Phrases that mean the user is explicitly asking to revisit earlier
 * experience. This is a heuristic, not a classifier: a false positive costs one
 * extra recall round-trip (the service still chooses depth), while a false
 * negative only loses a label because a new user input recalls anyway. The
 * matching is intentionally narrow to avoid firing on ordinary narration.
 */
const EXPLICIT_RECALL_PATTERNS: RegExp[] = [
	/回忆/,
	/回顾/,
	/还记得/,
	/记不记得/,
	/记得吗/,
	/以前(?:怎么|为什|如何|做过|说过|用|是)/,
	/之前(?:怎么|为什|如何|做过|说过|我们|是)/,
	/上次(?:怎么|为什|如何|我们|是)/,
	/\brecall\b/i,
	/\bremember\b/i,
	/\blast time\b/i,
	/\bpreviously\b/i,
];

/** detectExplicitRecall decides whether the prompt directly asks for memory. */
export function detectExplicitRecall(prompt: string): boolean {
	const text = prompt.trim();
	if (text === "") {
		return false;
	}
	return EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * detectTaskSwitch reports a working-context move. Only an observable change is
 * treated as a switch; an absent cwd is never assumed to be a different one.
 */
export function detectTaskSwitch(previousCwd: string | undefined, currentCwd: string | undefined): boolean {
	if (!previousCwd || !currentCwd) {
		return false;
	}
	return previousCwd !== currentCwd;
}

export function decideRecall(input: RecallInput): RecallDecision {
	if (input.inputsUnavailable) {
		// Never stop recalling because the decision itself could not be made.
		return { recall: true, trigger: "safe-default", reason: "scenario inputs unavailable" };
	}
	if (input.userRequestedRecall) {
		return { recall: true, trigger: "explicit-request", reason: "user asked to revisit earlier experience" };
	}
	if (input.taskSwitched) {
		// A context move is a stronger signal than a bare continuation, so it is
		// labelled before the generic new-input case.
		return { recall: true, trigger: "task-switch", reason: "the working task changed" };
	}
	if (input.hasNewUserInput) {
		return { recall: true, trigger: "new-user-request", reason: "turn starts from new user input" };
	}
	if (input.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
		return { recall: true, trigger: "repeated-failures", reason: `${input.consecutiveFailures} consecutive failures` };
	}
	if (input.lastInjectionTurnId !== undefined && input.lastInjectionTurnId === input.currentTurnId) {
		return { recall: false, reason: "this turn already received injected memory" };
	}
	if (input.newEvidenceSinceInjection) {
		return { recall: true, trigger: "safe-default", reason: "new evidence arrived since the last injection" };
	}
	return { recall: false, reason: "tool-driven turn without new input or evidence" };
}

/**
 * Scenario signals report what the client can observe. Every field is optional:
 * a value the client cannot observe is omitted rather than guessed, so the
 * service can tell the difference between "no failures" and "not reported".
 */
export interface ScenarioSignals {
	clarity?: "clear" | "partial" | "unclear";
	progress_percent?: number;
	repeated_failures?: number;
	conflict_count?: number;
	evidence_gap_count?: number;
}

export interface ScenarioInput {
	taskClarity?: "clear" | "partial" | "unclear";
	progressPercent?: number;
	consecutiveFailures?: number;
	conflictCount?: number;
	evidenceGapCount?: number;
}

export function buildScenarioSignals(input: ScenarioInput): ScenarioSignals {
	const signals: ScenarioSignals = {};
	if (input.taskClarity) {
		signals.clarity = input.taskClarity;
	}
	if (isPercentage(input.progressPercent)) {
		signals.progress_percent = input.progressPercent;
	}
	if (isCount(input.consecutiveFailures)) {
		signals.repeated_failures = input.consecutiveFailures;
	}
	if (isCount(input.conflictCount)) {
		signals.conflict_count = input.conflictCount;
	}
	if (isCount(input.evidenceGapCount)) {
		signals.evidence_gap_count = input.evidenceGapCount;
	}
	return signals;
}

function isPercentage(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCount(value: number | undefined): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

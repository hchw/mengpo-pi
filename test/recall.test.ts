import assert from "node:assert/strict";
import test from "node:test";

import { buildScenarioSignals, decideRecall, REPEATED_FAILURE_THRESHOLD } from "../src/recall.ts";

function base(overrides: Partial<Parameters<typeof decideRecall>[0]> = {}) {
	return {
		hasNewUserInput: false,
		taskSwitched: false,
		consecutiveFailures: 0,
		userRequestedRecall: false,
		newEvidenceSinceInjection: false,
		...overrides,
	};
}

test("a turn that starts from user input recalls", () => {
	const decision = decideRecall(base({ hasNewUserInput: true }));
	assert.equal(decision.recall, true);
	assert.equal(decision.recall && decision.trigger, "new-user-request");
});

test("a tool-driven turn without new input or evidence skips recall", () => {
	const decision = decideRecall(base({ hasNewUserInput: false }));
	assert.equal(decision.recall, false);
});

test("a turn already injected this turn is not injected again", () => {
	const decision = decideRecall(base({ lastInjectionTurnId: "turn-1", currentTurnId: "turn-1" }));
	assert.equal(decision.recall, false);
	assert.match(decision.reason, /already received/);
});

test("repeated failures re-trigger recall", () => {
	const decision = decideRecall(base({ consecutiveFailures: REPEATED_FAILURE_THRESHOLD }));
	assert.equal(decision.recall, true);
	assert.equal(decision.recall && decision.trigger, "repeated-failures");
});

test("a task switch and an explicit request both recall", () => {
	assert.equal(decideRecall(base({ taskSwitched: true })).recall, true);
	const explicit = decideRecall(base({ userRequestedRecall: true }));
	assert.equal(explicit.recall && explicit.trigger, "explicit-request");
});

test("new evidence recalls even on an otherwise quiet turn", () => {
	const decision = decideRecall(base({ newEvidenceSinceInjection: true }));
	assert.equal(decision.recall, true);
});

test("an unusable decision falls back to the safe default instead of going silent", () => {
	const decision = decideRecall(base({ inputsUnavailable: true }));
	assert.equal(decision.recall, true);
	assert.equal(decision.recall && decision.trigger, "safe-default");
});

test("scenario signals only report what was actually observed", () => {
	assert.deepEqual(buildScenarioSignals({}), {});
	assert.deepEqual(buildScenarioSignals({ taskClarity: "unclear" }), { clarity: "unclear" });
	assert.deepEqual(buildScenarioSignals({ consecutiveFailures: 3, conflictCount: 0 }), {
		repeated_failures: 3,
		conflict_count: 0,
	});
	// Out-of-range or non-finite values are omitted rather than clamped, so the
	// service is never told something the client did not observe.
	assert.deepEqual(buildScenarioSignals({ progressPercent: 140 }), {});
	assert.deepEqual(buildScenarioSignals({ progressPercent: Number.NaN }), {});
	assert.deepEqual(buildScenarioSignals({ consecutiveFailures: -1 }), {});
	assert.deepEqual(buildScenarioSignals({ evidenceGapCount: 1.5 }), {});
});

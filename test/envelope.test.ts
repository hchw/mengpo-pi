import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvelope } from "../src/envelope.ts";
import { deriveTrace, isEmptyTrace, stripProjection, toolResultType } from "../src/trace.ts";

test("a session-scoped envelope carries the session identifier", () => {
	const envelope = buildEnvelope({
		tenantId: "tenant-1",
		userId: "user-1",
		principalId: "user-1",
		scopeType: "session",
		sessionId: "session-1",
		requestId: "req-1",
		idempotencyKey: "idem-1",
		payload: { text: "hello" },
	});
	assert.equal(envelope.scope.type, "session");
	assert.equal(envelope.scope.session_id, "session-1");
	assert.equal(envelope.version, "v1");
	assert.equal(envelope.principal.type, "user");
});

test("a user-global envelope does not declare a session", () => {
	const envelope = buildEnvelope({
		tenantId: "tenant-1",
		userId: "user-1",
		principalId: "user-1",
		scopeType: "user-global",
		sessionId: "session-1",
		requestId: "req-1",
		idempotencyKey: "idem-1",
		payload: {},
	});
	assert.equal(envelope.scope.session_id, undefined);
});

test("observations default to private visibility", () => {
	const envelope = buildEnvelope({
		tenantId: "t",
		userId: "u",
		principalId: "u",
		scopeType: "session",
		sessionId: "s",
		requestId: "r",
		idempotencyKey: "i",
		payload: {},
	});
	assert.equal(envelope.privacy.visibility, "private");
});

test("the memory hint is only serialized when it says something", () => {
	const bare = buildEnvelope({
		tenantId: "t", userId: "u", principalId: "u", scopeType: "session", sessionId: "s",
		requestId: "r", idempotencyKey: "i", payload: {}, memoryHint: {},
	});
	assert.equal(bare.memory_hint, undefined);

	const hinted = buildEnvelope({
		tenantId: "t", userId: "u", principalId: "u", scopeType: "session", sessionId: "s",
		requestId: "r", idempotencyKey: "i", payload: {},
		memoryHint: { mode: "auto", topics: ["migration"], allowCandidates: false },
	});
	assert.equal(hinted.memory_hint?.mode, "auto");
	assert.equal(hinted.memory_hint?.allow_candidates, false);
});

test("a trace only contains identifiers that exist", () => {
	assert.equal(isEmptyTrace(deriveTrace({})), true);
	const trace = deriveTrace({ toolResultId: "call-1", projectionId: "  ", taskId: "task-1" });
	assert.deepEqual(trace, { task_id: "task-1", tool_result_id: "call-1" });
	assert.equal("projection_id" in trace, false);
});

test("an empty projection reference is dropped rather than sent as a placeholder", () => {
	const stripped = stripProjection({ projection_id: "p-1", task_id: "t-1" });
	assert.equal(stripped.projection_id, undefined);
	assert.equal(stripped.task_id, "t-1");
	assert.equal(isEmptyTrace(stripProjection({ projection_id: "p-1" })), true);
});

test("tool failures are expressed by event type, not by payload", () => {
	assert.equal(toolResultType(true), "tool.failure");
	assert.equal(toolResultType(false), "tool.result");
});

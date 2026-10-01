import assert from "node:assert/strict";
import test from "node:test";

import { CircuitBreaker } from "../src/breaker.ts";
import { MemoryClient } from "../src/client.ts";
import { INJECTION_MARKER, MemoryBridge, renderInjection, sequenceOf, truncate } from "../src/memory.ts";
import { createFetch, defaultServer, jsonResponse, type RecordedCall } from "./support.ts";

async function newBridge(handler = defaultServer(), breaker?: CircuitBreaker) {
	const fake = createFetch({ handler: (path: string, call: RecordedCall) => handler(path, call) });
	const client = new MemoryClient({
		baseUrl: "http://memory:8080",
		assertion: "dev@mengpo.local",
		timeoutMs: 500,
		fetchImpl: fake.fetch,
		newId: () => "generated-id",
	});
	const degradations: string[] = [];
	const bridge = new MemoryBridge({
		client,
		breaker: breaker ?? new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => 0 }),
		onDegrade: (reason) => degradations.push(reason),
	});
	await bridge.bind("pi-session-1", "demo");
	return { bridge, fake, degradations };
}

function observeBodies(fake: ReturnType<typeof createFetch>): any[] {
	return fake.calls.filter((call) => call.url.endsWith("/api/v1/observe")).map((call) => call.body.payload);
}

test("binding failure leaves the session usable and reports a degradation", async () => {
	const fake = createFetch({
		handler: (path) =>
			path === "/api/v1/auth/sso/exchange"
				? jsonResponse({ status: 500, error: { code: "INTERNAL", message: "down" } })
				: jsonResponse({ status: 500, error: { code: "INTERNAL", message: "down" } }),
	});
	const client = new MemoryClient({ baseUrl: "http://memory:8080", assertion: "a", fetchImpl: fake.fetch });
	const degradations: string[] = [];
	const bridge = new MemoryBridge({ client, onDegrade: (reason) => degradations.push(reason) });
	assert.equal(await bridge.bind("pi-session-1", "demo"), false);
	assert.equal(bridge.sessionId, "");
	assert.deepEqual(degradations, ["session binding failed"]);
});

test("recall injects returned memories and remembers the projection", async () => {
	const { bridge } = await newBridge();
	bridge.beginTurn({ turnId: "turn-1" });
	const outcome = await bridge.recall({ hasNewUserInput: true, query: "pgvector" });
	assert.equal(outcome.itemCount, 1);
	assert.equal(outcome.projectionId, "projection-1");
	assert.equal(bridge.projectionId, "projection-1");
	assert.match(outcome.injection ?? "", /mengpo_memory/);
	assert.match(outcome.injection ?? "", /pgvector keeps the index local/);
});

test("a turn that skips recall leaves the prompt untouched", async () => {
	const { bridge, fake } = await newBridge();
	bridge.beginTurn({ turnId: "turn-1" });
	const first = await bridge.recall({ hasNewUserInput: true, query: "q" });
	assert.ok(first.injection);
	const before = fake.calls.length;
	bridge.beginTurn({ turnId: "turn-1" });
	const second = await bridge.recall({ hasNewUserInput: false, query: "q" });
	assert.equal(second.itemCount, 0);
	assert.equal(second.injection, undefined);
	assert.equal(fake.calls.length, before, "a skipped turn must not call the service");
});

test("a recall failure degrades without throwing and without injecting", async () => {
	const { bridge, degradations } = await newBridge((path, call) =>
		path === "/api/v1/project" ? jsonResponse({ status: 503, error: { code: "UNAVAILABLE", message: "down" } }) : defaultServer()(path, call),
	);
	bridge.beginTurn({ turnId: "turn-1" });
	const outcome = await bridge.recall({ hasNewUserInput: true, query: "q" });
	assert.equal(outcome.injection, undefined);
	assert.deepEqual(degradations, ["recall failed"]);
});

test("reported observations are idempotent per identifier", async () => {
	const { bridge, fake } = await newBridge();
	const event = {
		scopeType: "session" as const,
		sessionId: bridge.sessionId,
		sourceType: "tool" as const,
		messageType: "tool.result",
		trace: {},
		payload: { tool_call_id: "call-1" },
		idempotencyKey: "tool:call-1",
	};
	await bridge.observe(event);
	await bridge.observe(event);
	assert.equal(observeBodies(fake).length, 1);
});

test("an observation declares its source and event type instead of encoding failure in payload", async () => {
	const { bridge, fake } = await newBridge();
	await bridge.reportToolResult({ toolCallId: "call-9", isError: true, note: { turnId: "turn-1" }, summary: "boom" });
	const [payload] = observeBodies(fake);
	assert.equal(payload.source_type, "tool");
	assert.equal(payload.message_type, "tool.failure");
	assert.equal(payload.trace.tool_result_id, "call-9");
	assert.equal(bridge.failures, 1);
});

test("tool results carry pi's tool call identifier as the tool result trace", async () => {
	const { bridge, fake } = await newBridge();
	await bridge.reportToolResult({
		toolCallId: "call-1",
		isError: false,
		note: { turnId: "turn-1", entryId: "0000001a" },
		summary: "ok",
	});
	const [payload] = observeBodies(fake);
	assert.equal(payload.trace.tool_result_id, "call-1");
	assert.equal(payload.trace.task_id, "turn-1");
	assert.equal(typeof payload.sequence, "number");
});

test("a successful tool result clears the failure run", async () => {
	const { bridge } = await newBridge();
	await bridge.reportToolResult({ toolCallId: "c1", isError: true, note: {}, summary: "boom" });
	await bridge.reportToolResult({ toolCallId: "c2", isError: false, note: {}, summary: "ok" });
	assert.equal(bridge.failures, 0);
});

test("injected memory is marked on later observations so it cannot reinforce itself", async () => {
	const { bridge, fake } = await newBridge();
	bridge.beginTurn({ turnId: "turn-1" });
	await bridge.recall({ hasNewUserInput: true, query: "q" });
	await bridge.reportTurnOutcome({ note: { turnId: "turn-1", entryId: "entry-1" }, outcomeId: "outcome-1", summary: "done", failed: false });
	const payload = observeBodies(fake)[0];
	assert.deepEqual(payload.mengpo_injected_memory_ids, ["memory-1"]);
});

test("a projection reference is attached to later events of the same turn", async () => {
	const { bridge, fake } = await newBridge();
	bridge.beginTurn({ turnId: "turn-1" });
	await bridge.recall({ hasNewUserInput: true, query: "q" });
	await bridge.reportToolResult({ toolCallId: "call-1", isError: false, note: { turnId: "turn-1" }, summary: "ok" });
	const payload = observeBodies(fake)[0];
	assert.equal(payload.trace.projection_id, "projection-1");
});

test("feedback without a real memory target is not sent", async () => {
	const { bridge, fake } = await newBridge();
	assert.equal(await bridge.feedback("", "corrected", "wrong", "idem-1"), false);
	assert.equal(fake.calls.some((call) => call.url.endsWith("/api/v1/feedback")), false);
});

test("feedback with a memory target is sent with that target", async () => {
	const { bridge, fake } = await newBridge();
	assert.equal(await bridge.feedback("memory-1", "corrected", "wrong", "idem-1"), true);
	const call = fake.calls.find((entry) => entry.url.endsWith("/api/v1/feedback"));
	assert.equal(call?.body.payload.memory_id, "memory-1");
});

test("the breaker stops the extension from retrying a down service every turn", async () => {
	const { bridge, fake } = await newBridge(
		(path) =>
			path === "/api/v1/observe"
				? jsonResponse({ status: 503, error: { code: "UNAVAILABLE", message: "down" } })
				: defaultServer()(path, undefined as any),
	);
	for (let i = 0; i < 5; i += 1) {
		await bridge.observe({
			scopeType: "session",
			sessionId: bridge.sessionId,
			sourceType: "tool",
			messageType: "tool.result",
			trace: {},
			payload: {},
			idempotencyKey: `key-${i}`,
		});
	}
	const attempted = fake.calls.filter((call) => call.url.endsWith("/api/v1/observe")).length;
	assert.equal(attempted, 2, "after the threshold the breaker must stop calling");
});

test("an unbound bridge makes no calls at all", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const client = new MemoryClient({ baseUrl: "http://memory:8080", assertion: "a", fetchImpl: fake.fetch });
	const bridge = new MemoryBridge({ client });
	await bridge.observe({
		scopeType: "session",
		sessionId: "session-1",
		sourceType: "tool",
		messageType: "tool.result",
		trace: {},
		payload: {},
		idempotencyKey: "k",
	});
	assert.equal(fake.calls.length, 0);
});

test("the injection block is wrapped so the transcript can tell it apart", () => {
	const rendered = renderInjection(["first", "second"]);
	assert.ok(rendered.startsWith(INJECTION_MARKER));
	assert.ok(rendered.endsWith("</mengpo_memory>"));
	assert.match(rendered, /- first/);
	assert.match(rendered, /- second/);
});

test("sequence and truncation helpers stay bounded", () => {
	assert.equal(sequenceOf(undefined), undefined);
	assert.equal(sequenceOf("not-hex-string"), undefined);
	assert.equal(sequenceOf("0000001a-rest"), 26);
	assert.equal(truncate("short", 10), "short");
	assert.equal(truncate("0123456789", 4), "0123…");
});

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, MemoryClient } from "../src/client.ts";
import { createFetch, defaultServer, jsonResponse } from "./support.ts";

function newClient(plan: Parameters<typeof createFetch>[0]) {
	const fake = createFetch(plan);
	const client = new MemoryClient({
		baseUrl: "http://memory:8080",
		assertion: "dev@mengpo.local",
		timeoutMs: 500,
		fetchImpl: fake.fetch,
		newId: () => "generated-id",
	});
	return { client, fake };
}

test("enroll exchanges the assertion, keeps the cookie and selects a tenant", async () => {
	const { client, fake } = newClient({ handler: defaultServer() });
	const context = await client.enroll();
	assert.deepEqual(context, { tenantId: "tenant-1", userId: "user-1", roles: ["tenant-admin"] });
	assert.deepEqual(fake.paths(), ["/api/v1/auth/sso/exchange", "/api/v1/auth/tenant-context"]);
	assert.equal(fake.calls[1]?.body.tenant_id, "tenant-1");
});

test("a configured tenant is selected instead of the first one offered", async () => {
	const { client, fake } = newClient({ handler: defaultServer() });
	const configured = new MemoryClient({
		baseUrl: "http://memory:8080",
		assertion: "a",
		tenantId: "tenant-explicit",
		fetchImpl: fake.fetch,
		newId: () => "id",
	});
	await configured.enroll();
	assert.equal(fake.calls[1]?.body.tenant_id, "tenant-explicit");
});

test("the session cookie is replayed on later calls", async () => {
	const { client, fake } = newClient({ handler: defaultServer() });
	await client.bindSession("pi-session-1", "demo");
	const observeCall = fake.calls.find((call) => call.url.endsWith("/api/v1/observe"));
	assert.equal(observeCall, undefined);
	const sessionCall = fake.calls.find((call) => call.url.endsWith("/api/v1/sessions"));
	assert.match(sessionCall?.headers.Cookie ?? "", /mengpo_session=token-1/);
});

test("binding reports the session identity the server assigned", async () => {
	const { client } = newClient({ handler: defaultServer() });
	assert.equal(await client.bindSession("pi-session-1", "demo"), "session-1");
});

test("a session-scoped observe carries the bound session in its scope", async () => {
	const { client, fake } = newClient({ handler: defaultServer() });
	await client.bindSession("pi-session-1", "demo");
	await client.observe({
		scopeType: "session",
		sessionId: "session-1",
		idempotencyKey: "idem-1",
		payload: { source_type: "tool", message_type: "tool.result" },
	});
	const call = fake.calls.find((entry) => entry.url.endsWith("/api/v1/observe"));
	assert.equal(call?.body.scope.session_id, "session-1");
	assert.equal(call?.body.scope.type, "session");
	assert.equal(call?.body.principal.type, "user");
});

test("a rejection of ingress fields degrades to a pre-ingress report", async () => {
	let attempts = 0;
	const { client, fake } = newClient({
		handler: (path, call) => {
			if (path === "/api/v1/observe") {
				attempts += 1;
				if (attempts === 1) {
					return jsonResponse({ status: 400, error: { code: "INVALID_ENVELOPE", message: "unknown field" } });
				}
				return jsonResponse({ data: { event_id: "event-2", created: true } });
			}
			return defaultServer()(path, call);
		},
	});
	await client.bindSession("pi-session-1", "demo");
	const result = await client.observe({
		scopeType: "session",
		sessionId: "session-1",
		idempotencyKey: "idem-trace",
		payload: {
			source_event_id: "node-e1",
			source_type: "tool",
			message_type: "tool.failure",
			sequence: 3,
			parent_event_id: "e1",
			text: "boom",
			payload: { outcome: "error" },
			trace: { projection_id: "projection-1", tool_result_id: "call-1" },
		},
	});
	assert.equal(result.eventId, "event-2");
	const observeCalls = fake.calls.filter((call) => call.url.endsWith("/api/v1/observe"));
	assert.equal(observeCalls.length, 2);
	const first = observeCalls[0]!.body.payload;
	assert.equal(first.source_type, "tool");
	assert.equal(first.trace.projection_id, "projection-1");
	const second = observeCalls[1]!.body.payload;
	assert.equal("trace" in second, false);
	assert.equal("source_type" in second, false);
	assert.equal("sequence" in second, false);
	assert.equal("parent_event_id" in second, false);
	assert.equal(second.source_event_id, "node-e1");
	assert.equal(second.message_type, "tool.failure");
	assert.equal(second.text, "boom");
	assert.deepEqual(second.payload, { outcome: "error" });
});

test("a rejection of the scenario field degrades to a recall without it", async () => {
	let attempts = 0;
	const { client, fake } = newClient({
		handler: (path, call) => {
			if (path === "/api/v1/project") {
				attempts += 1;
				if (attempts === 1) {
					return jsonResponse({ status: 400, error: { code: "INVALID_ENVELOPE", message: "unknown field scenario" } });
				}
			}
			return defaultServer()(path, call);
		},
	});
	await client.bindSession("pi-session-1", "demo");
	const result = await client.project({
		scopeType: "session",
		sessionId: "session-1",
		idempotencyKey: "idem-scenario",
		query: "q",
		scenario: { repeated_failures: 2 },
	});
	assert.equal(result.projectionId, "projection-1");
	const projectCalls = fake.calls.filter((call) => call.url.endsWith("/api/v1/project"));
	assert.equal(projectCalls.length, 2);
	assert.deepEqual(projectCalls[0]!.body.payload.scenario, { repeated_failures: 2 });
	assert.equal("scenario" in projectCalls[1]!.body.payload, false);
});

test("a rejection that is not about unknown fields is surfaced", async () => {
	const { client } = newClient({
		handler: (path, call) => {
			if (path === "/api/v1/observe") {
				return jsonResponse({ status: 500, error: { code: "INTERNAL", message: "boom" } });
			}
			return defaultServer()(path, call);
		},
	});
	await client.bindSession("pi-session-1", "demo");
	await assert.rejects(
		() =>
			client.observe({
				scopeType: "session",
				sessionId: "session-1",
				idempotencyKey: "idem-1",
				payload: { trace: { projection_id: "p" } },
			}),
		(error: unknown) => error instanceof ApiError && error.code === "INTERNAL",
	);
});

test("a projection exposes its identity, its memories and its mode", async () => {
	const { client } = newClient({ handler: defaultServer() });
	const result = await client.project({
		scopeType: "session",
		sessionId: "session-1",
		idempotencyKey: "idem-1",
		query: "pgvector",
		scenario: { repeated_failures: 2 },
	});
	assert.equal(result.projectionId, "projection-1");
	assert.equal(result.mode, "focus");
	assert.deepEqual(result.items, [{ text: "pgvector keeps the index local", memoryId: "memory-1" }]);
});

test("empty projections produce no injection material", async () => {
	const { client } = newClient({
		handler: (path, call) =>
			path === "/api/v1/project"
				? jsonResponse({ data: { items: [{ Text: "   ", Candidate: { Node: { ID: "m" } } }], metadata: { mode: "focus" } } })
				: defaultServer()(path, call),
	});
	const result = await client.project({ scopeType: "user-global", idempotencyKey: "i", query: "q" });
	assert.deepEqual(result.items, []);
	assert.equal(result.projectionId, undefined);
});

test("an authentication failure is an error the caller can classify", async () => {
	const { client } = newClient({
		handler: (path) =>
			path === "/api/v1/auth/sso/exchange"
				? jsonResponse({ status: 400, error: { code: "AUTH_FAILED", message: "authentication failed" } })
				: jsonResponse({ status: 404, error: { code: "NOT_FOUND", message: "x" } }),
	});
	await assert.rejects(() => client.enroll(), (error: unknown) => error instanceof ApiError && error.status === 400);
});

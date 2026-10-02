import assert from "node:assert/strict";
import test from "node:test";

import mengpoExtension, { loadUserConfig, USER_CONFIG_PATH } from "../src/extension.ts";
import { createFetch, defaultServer, jsonResponse } from "./support.ts";

interface FakePi {
	handlers: Map<string, (event: any, ctx: any) => any>;
	tools: string[];
	commands: string[];
	commandHandlers: Map<string, (args: string, ctx: any) => any>;
	emit: (name: string, event: any, ctx: any) => Promise<any>;
}

function fakePi(): FakePi {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const tools: string[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<string, (args: string, ctx: any) => any>();
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => any) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerTool: (tool: any) => {
			tools.push(tool.name);
		},
		registerCommand: (name: string, options: any) => {
			commands.push(name);
			commandHandlers.set(name, options.handler);
		},
	};
	mengpoExtension(pi);
	return {
		handlers,
		tools,
		commands,
		commandHandlers,
		emit: async (name: string, event: any, ctx: any) => {
			const handler = handlers.get(name);
			if (!handler) {
				throw new Error(`no handler for ${name}`);
			}
			return handler(event, ctx);
		},
	};
}

function fakeContext(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/home/dev/project",
		mode: "tui",
		hasUI: false,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "pi-session-1", getLeafId: () => "0000001a" },
		...overrides,
	};
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		saved[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});
}

test("a missing user configuration file is not an error", () => {
	assert.deepEqual(loadUserConfig("/nonexistent/mengpo.json"), {});
	assert.equal(USER_CONFIG_PATH.endsWith("mengpo.json"), true);
});

test("the extension registers its tools and its command", () => {
	const pi = fakePi();
	assert.deepEqual(pi.tools.sort(), ["memory_correct", "memory_forget", "memory_recall", "memory_remember"]);
	assert.deepEqual(pi.commands, ["memory"]);
});

test("the extension opens no connection while loading", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		fakePi();
		assert.equal(fake.calls.length, 0);
	} finally {
		globalThis.fetch = original;
	}
});

test("an unconfigured extension stays inert for the whole session", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: undefined, MENGPO_PI_ASSERTION: undefined },
			async () => {
				const pi = fakePi();
				const ctx = fakeContext();
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				const outcome = await pi.emit(
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hello", systemPromptOptions: { sections: {} } },
					ctx,
				);
				assert.equal(outcome, undefined);
				assert.equal(fake.calls.length, 0);
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("a configured extension binds, injects a prompt section and reports the turn", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const ctx = fakeContext();
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				assert.equal(fake.calls.some((call) => call.url.endsWith("/api/v1/sessions")), true);

				const sections: Record<string, string> = {};
				const event: any = { type: "before_agent_start", prompt: "why did the migration fail?", systemPromptOptions: { sections } };
				await pi.emit("before_agent_start", event, ctx);
				assert.ok(sections.mengpo_memory, "the memory section must be appended");
				assert.match(sections.mengpo_memory, /pgvector keeps the index local/);
				// The whole prompt must not be replaced.
				assert.equal(event.systemPrompt, undefined);

				await pi.emit("turn_end", { type: "turn_end", messageEntryId: "0000001a", message: { content: [{ type: "text", text: "done" }] } }, ctx);
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(fake.calls.some((call) => call.url.endsWith("/api/v1/observe")), true);
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("a failing service does not break the session", async () => {
	const fake = createFetch({
		handler: () => jsonResponse({ status: 503, error: { code: "UNAVAILABLE", message: "down" } }),
	});
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const ctx = fakeContext();
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				const sections: Record<string, string> = {};
				const event: any = { type: "before_agent_start", prompt: "hello", systemPromptOptions: { sections } };
				await pi.emit("before_agent_start", event, ctx);
				assert.deepEqual(sections, {});
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("session shutdown is idempotent and leaves the extension inert", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const ctx = fakeContext();
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
				await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
				const before = fake.calls.length;
				const sections: Record<string, string> = {};
				await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections } }, ctx);
				assert.equal(fake.calls.length, before);
				assert.deepEqual(sections, {});
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("memory tools answer usefully when memory is not configured", async () => {
	let captured: any;
	const pi = {
		on: () => () => {},
		registerTool: (tool: any) => {
			if (tool.name === "memory_recall") {
				captured = tool;
			}
		},
		registerCommand: () => {},
	};
	await withEnv({ MENGPO_PI_BASE_URL: undefined, MENGPO_PI_ASSERTION: undefined }, async () => {
		mengpoExtension(pi as any);
	});
	const result = await captured.execute("id", { query: "anything" }, undefined, undefined, fakeContext());
	assert.match(result.content[0].text, /not configured/i);
	assert.equal(result.details.connected, false);
});

test("the memory command reports state in interactive mode and stays silent otherwise", async () => {
	const pi = fakePi();
	const notifications: string[] = [];
	const tui = fakeContext({ hasUI: true, ui: { notify: (line: string) => notifications.push(line) } });
	await withEnv({ MENGPO_PI_BASE_URL: undefined, MENGPO_PI_ASSERTION: undefined }, async () => {
		await pi.emit("session_start", { type: "session_start" }, tui);
	});
	const handler = pi.commandHandlers.get("memory");
	assert.ok(handler);
	await handler!("", tui);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /not configured/);

	// A non-interactive mode has no UI to report to; the command must not fail.
	await handler!("", fakeContext({ hasUI: false, ui: undefined, mode: "json" }));
});

test("recall and injection are announced to the person", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	const notifications: string[] = [];
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const ctx = fakeContext({ hasUI: true, ui: { notify: (line: string) => notifications.push(line) } });
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				const sections: Record<string, string> = {};
				await pi.emit(
					"before_agent_start",
					{ type: "before_agent_start", prompt: "what failed?", systemPromptOptions: { sections } },
					ctx,
				);
			},
		);
	} finally {
		globalThis.fetch = original;
	}
	assert.equal(notifications.some((line) => /记忆获取 1 条/.test(line)), true);
	assert.equal(notifications.some((line) => /记忆注入 1 条/.test(line)), true);
});

test("a working-directory change is announced as a task switch", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	const notifications: string[] = [];
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const ctx = (cwd: string) =>
					fakeContext({ cwd, hasUI: true, ui: { notify: (line: string) => notifications.push(line) } });
				await pi.emit("session_start", { type: "session_start" }, ctx("/repo/a"));
				await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "first task", systemPromptOptions: { sections: {} } }, ctx("/repo/a"));
				await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "second task", systemPromptOptions: { sections: {} } }, ctx("/repo/b"));
			},
		);
	} finally {
		globalThis.fetch = original;
	}
	assert.equal(notifications.some((line) => /触发=任务切换/.test(line)), true);
});

test("reported turn events carry real session entry parents and ordering", async () => {
	const fake = createFetch({ handler: defaultServer() });
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch;
	try {
		await withEnv(
			{ MENGPO_PI_BASE_URL: "http://memory:8080", MENGPO_PI_ASSERTION: "dev@mengpo.local" },
			async () => {
				const pi = fakePi();
				const branch = [
					{ id: "e0", parentId: null },
					{ id: "e1", parentId: "e0" },
					{ id: "e2", parentId: "e1" },
				];
				const ctx = fakeContext({
					sessionManager: {
						getSessionId: () => "pi-session-1",
						getLeafId: () => "e1",
						getBranch: () => branch,
						getEntry: (id: string) => branch.find((entry) => entry.id === id),
					},
				});
				await pi.emit("session_start", { type: "session_start" }, ctx);
				await pi.emit(
					"before_agent_start",
					{ type: "before_agent_start", prompt: "why did it fail?", systemPromptOptions: { sections: {} } },
					ctx,
				);
				await pi.emit(
					"turn_end",
					{
						type: "turn_end",
						messageEntryId: "e1",
						message: { content: [{ type: "text", text: "done" }] },
						toolResults: [{ toolCallId: "call-1", isError: false, content: [{ type: "text", text: "ok" }] }],
						toolResultEntryIds: ["e2"],
					},
					ctx,
				);
				await new Promise((resolve) => setTimeout(resolve, 30));
			},
		);
	} finally {
		globalThis.fetch = original;
	}
	const observes = fake.calls.filter((call) => call.url.endsWith("/api/v1/observe")).map((call) => call.body.payload);
	const tool = observes.find((payload) => payload.source_type === "tool");
	assert.equal(tool?.source_event_id, "e2");
	assert.equal("parent_event_id" in (tool ?? {}), false);
	assert.equal(tool?.sequence, 2);
	assert.equal(tool?.trace.tool_result_id, "call-1");
	assert.equal(tool?.trace.projection_id, "projection-1");
	assert.equal(tool?.payload.parent_entry_id, "e1");
	const outcome = observes.find((payload) => payload.message_type === "turn.outcome");
	assert.equal(outcome?.source_event_id, "e1");
	assert.equal(outcome?.sequence, 1);
	assert.equal(outcome?.payload.parent_entry_id, "e0");
	// The outcome event repeats the turn's last tool call so a single event can
	// carry both the tool result and the outcome (direct attribution).
	assert.equal(outcome?.trace.tool_result_id, "call-1");
	assert.equal(outcome?.trace.outcome_id, "e1");
});

/**
 * pi extension entry point.
 *
 * Wires pi's lifecycle into the memory bridge. Nothing long-lived is created at
 * load time: the client and the session binding are established in
 * `session_start` and released in `session_shutdown`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { CircuitBreaker } from "./breaker.ts";
import { MemoryClient } from "./client.ts";
import { resolveAccess, scrub, type AccessConfig } from "./config.ts";
import { INJECTION_MARKER, MemoryBridge, renderInjection, truncate } from "./memory.ts";
import { detectExplicitRecall, detectTaskSwitch } from "./recall.ts";
import { EVENT_TYPES } from "./trace.ts";

export const USER_CONFIG_PATH = join(homedir(), ".pi", "mengpo.json");

/**
 * Environment override for the user config path. An explicit value wins so a
 * caller (or a test) can point at a different file; an empty value disables the
 * file entirely. Without it, the developer's real ~/.pi/mengpo.json would leak
 * into environments that mean to run unconfigured.
 */
const USER_CONFIG_ENV = "MENGPO_PI_CONFIG";

/** Load the optional user configuration file. A missing file is not an error. */
export function loadUserConfig(path: string = process.env[USER_CONFIG_ENV] ?? USER_CONFIG_PATH): Partial<Record<string, string>> {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const result: Record<string, string> = {};
		for (const key of ["baseUrl", "assertion", "tenantId", "timeoutMs"]) {
			const value = parsed[key];
			if (typeof value === "string") {
				result[key] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

interface ExtensionState {
	config: AccessConfig;
	client: MemoryClient;
	bridge: MemoryBridge;
}

/**
 * A plain JSON-Schema object. TypeBox schemas are JSON Schema at runtime, so the
 * parameters work without taking a build-time dependency on a schema library.
 */
function objectSchema(properties: Record<string, unknown>, required: string[] = []): unknown {
	return { type: "object", properties, required, additionalProperties: false };
}

const SEARCH_PARAMS = objectSchema({ query: { type: "string", description: "What to look for" } }, ["query"]);
const REMEMBER_PARAMS = objectSchema({ text: { type: "string", description: "The fact or preference to keep" } }, ["text"]);

/**
 * contentKey derives the idempotency key from the instruction's content rather
 * than the clock. A time key collides when two calls land in the same
 * millisecond (parallel tool calls), silently dropping one; a content key still
 * dedupes a genuine retry of the same instruction.
 */
function contentKey(prefix: string, text: string): string {
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 24);
	return `${prefix}:${digest}`;
}
const CORRECT_PARAMS = objectSchema(
	{
		memory_id: { type: "string", description: "Identifier of the memory being corrected" },
		text: { type: "string", description: "What the correct version is" },
		reason: { type: "string", description: "Why the memory is wrong" },
	},
	["memory_id", "text"],
);

export default function mengpoExtension(pi: any): void {
	let state: ExtensionState | undefined;
	// Tracks the working directory across turns so a real context move can be
	// told apart from a plain continuation. Reset with the session.
	let previousCwd: string | undefined;
	// Memory fetched for the current user turn. It is bound to the user message
	// that started the turn and applied at the tail of the request by the `context`
	// handler, then reset on the next `before_agent_start`. It must never enter
	// the system prompt: see the `context` handler for why.
	let pendingInjection: string | undefined;
	// Injection text bound to each user message, keyed by the message's identity.
	// Re-attaching the same text on every request keeps the effective prefix
	// byte-identical, so the prompt cache survives across turns. This is a
	// request-time projection only; pi never stores it in the transcript.
	const messageInjections = new Map<string, string>();
	const note = (reason: string, error?: unknown): void => {
		if (!state) {
			return;
		}
		if (process.env.MENGPO_PI_DEBUG === "1") {
			const detail = error instanceof Error ? error.message : String(error ?? "");
			process.stderr.write(`[mengpo] ${scrub(`${reason} ${detail}`, state.config.assertion)}\n`);
		}
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		// Configuration resolution and the client are session-scoped so that
		// loading the extension never opens a connection.
		previousCwd = undefined;
		pendingInjection = undefined;
		messageInjections.clear();
		const config = resolveAccess({ env: process.env, file: loadUserConfig() });
		if (!config) {
			state = undefined;
			return;
		}
		const client = new MemoryClient({
			baseUrl: config.baseUrl,
			assertion: config.assertion,
			tenantId: config.tenantId,
			timeoutMs: config.timeoutMs,
		});
		const bridge = new MemoryBridge({ client, breaker: new CircuitBreaker(), onDegrade: note });
		state = { config, client, bridge };
		const externalId = safeSessionId(ctx);
		try {
			const bound = await bridge.bind(externalId, truncate(ctx?.cwd ?? "pi session", 120));
			if (bound && ctx?.hasUI) {
				ctx.ui?.notify?.("mengpo: memory connected", "info");
			}
		} catch (error) {
			note("session binding failed", error);
		}
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const current = state;
		if (!current) {
			return;
		}
		// A new user turn supersedes any memory injected for the previous one.
		pendingInjection = undefined;
		const turnId = safeLeafId(ctx) ?? safeSessionId(ctx);
		current.bridge.beginTurn({ turnId });
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		// A non-empty prompt means this request starts from user input; a bare
		// continuation is tool-driven and normally needs no fresh recall.
		const hasNewUserInput = prompt.trim() !== "";
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
		const taskSwitched = detectTaskSwitch(previousCwd, cwd);
		previousCwd = cwd ?? previousCwd;
		const userRequestedRecall = detectExplicitRecall(prompt);
		let outcome;
		try {
			outcome = await current.bridge.recall({
				hasNewUserInput,
				taskSwitched,
				userRequestedRecall,
				query: truncate(prompt, 2000),
			});
		} catch (error) {
			note("recall failed", error);
			return;
		}
		if (!outcome) {
			return;
		}
		const decided = outcome.decided;
		if (!decided.recall) {
			announceDebug(ctx, `mengpo: 本轮跳过记忆召回（${decided.reason}）`);
			return;
		}
		// A recall decision that reached the service is a completed project
		// round-trip; surface what was fetched and, separately, what was injected.
		announce(ctx, `mengpo: 记忆获取 ${outcome.itemCount} 条 · 触发=${triggerLabel(decided.trigger)}`);
		if (outcome.injection) {
			pendingInjection = outcome.injection;
			announce(ctx, `mengpo: 记忆注入 ${outcome.itemCount} 条`);
		}
	});

	// Inject memory at the tail of the request, never in the system prompt.
	//
	// The system prompt is the first thing in every request. A provider caches on
	// the request prefix, and pi puts the cache breakpoints on the system prompt
	// and the last message, so any per-turn change to the system prompt (which is
	// what a `systemPromptOptions.sections` write becomes once pi folds system
	// messages into the leading prompt for OpenAI-compatible APIs) invalidates the
	// entire cached prefix from the very first token. Instead the memory is bound
	// to the user message that started the turn and re-attached there on every
	// request: the prefix (system prompt plus all earlier turns, each with its own
	// stable injection) never changes, so only genuinely new tail content is
	// uncached. The change is request-local: pi discards it after the request, so
	// it never enters the stored transcript.
	pi.on("context", async (event: any) => {
		if (!state) {
			return;
		}
		const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
		// Bind the freshly recalled memory to the user message that opened this
		// turn, so every later request re-attaches the exact same text even after
		// the transcript has grown.
		if (pendingInjection) {
			const index = lastUserMessageIndex(messages);
			if (index >= 0) {
				const key = messageKey(messages[index]);
				if (key !== "") {
					messageInjections.set(key, pendingInjection);
				}
				pendingInjection = undefined;
			}
		}
		if (messageInjections.size === 0) {
			return;
		}
		let changed = false;
		const next = messages.map((message: any) => {
			if (message?.role !== "user") {
				return message;
			}
			const injection = messageInjections.get(messageKey(message));
			if (!injection || messageContains(message, INJECTION_MARKER)) {
				return message;
			}
			changed = true;
			return { ...message, content: appendText(message?.content, injection) };
		});
		return changed ? { messages: next } : undefined;
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		const current = state;
		if (!current) {
			return;
		}
		// Tool result entries only exist by the end of the turn, so reporting is
		// anchored here where pi can hand back the real session entry ids and
		// their parent links. Nothing is invented for an identifier that is not
		// yet known.
		const branch = safeBranch(ctx);
		const outcomeId = typeof event.messageEntryId === "string" ? event.messageEntryId : undefined;
		const results: any[] = Array.isArray(event.toolResults) ? event.toolResults : [];
		const entryIds: string[] = Array.isArray(event.toolResultEntryIds) ? event.toolResultEntryIds : [];
		let lastToolCallId: string | undefined;
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index] ?? {};
			const entryId = entryIds[index];
			const toolCallId = String(result.toolCallId ?? "");
			if (toolCallId) {
				lastToolCallId = toolCallId;
			}
			void current.bridge
				.reportToolResult({
					toolCallId,
					isError: Boolean(result.isError),
					note: {
						turnId: outcomeId,
						entryId,
						parentEntryId: parentEntryId(ctx, entryId),
						sequence: sequenceFromBranch(branch, entryId),
					},
					summary: textOf(result),
				})
				.catch(() => {});
		}
		// The outcome event also carries the turn's last tool call so the service
		// can reach direct attribution from one event (tool result + outcome on
		// the same turn); a turn with no tools omits it rather than inventing one.
		void current.bridge
			.reportTurnOutcome({
				note: {
					turnId: outcomeId,
					entryId: outcomeId,
					parentEntryId: parentEntryId(ctx, outcomeId),
					sequence: sequenceFromBranch(branch, outcomeId),
				},
				outcomeId: outcomeId ?? "",
				summary: textOf(event.message),
				failed: current.bridge.failures > 0,
				lastToolCallId,
			})
			.catch(() => {});
	});

	// Compaction and branch-summary boundaries are where the runtime has already
	// distilled the session, so they are reported as session events that trigger
	// memory extraction. This keeps per-turn reporting cheap and model-free.
	pi.on("session_compact", async (event: any, ctx: any) => {
		const current = state;
		if (!current) {
			return;
		}
		const summary = summaryText(event?.compactionEntry);
		if (summary === "") {
			return;
		}
		await current.bridge.reportCompaction({ summary, entryId: idOf(event?.compactionEntry) });
		announce(ctx, "mengpo: 会话已压缩，正在提炼记忆");
	});
	pi.on("session_tree", async (event: any, ctx: any) => {
		const current = state;
		if (!current) {
			return;
		}
		const summary = summaryText(event?.summaryEntry);
		if (summary === "") {
			return;
		}
		await current.bridge.reportBranchSummary({ summary, entryId: idOf(event?.summaryEntry) });
		announce(ctx, "mengpo: 分支已总结，正在提炼记忆");
	});
	pi.on("session_shutdown", async () => {
		// Idempotent: cancellation, reload, session replacement and exit can all
		// converge here.
		state = undefined;
		pendingInjection = undefined;
		messageInjections.clear();
	});

	pi.registerCommand("memory", {
		description: "Show whether Mengpo memory is connected and what it injected",
		handler: async (_args: string, ctx: any) => {
			const current = state;
			const line = current ? current.bridge.status() : "mengpo: not configured";
			report(ctx, line);
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Recall memory",
		description:
			"Search Mengpo long-term memory for prior decisions, preferences, or context. Call before answering anything that depends on earlier sessions.",
		promptSnippet: "memory_recall: look up prior decisions, preferences, and session context",
		promptGuidelines: [
			"Call memory_recall when the user references earlier work, prior decisions, or their own preferences ('last time', 'previously', 'do you remember'), or after switching tasks, instead of answering from your own knowledge.",
		],
		parameters: SEARCH_PARAMS,
		execute: async (_id: string, params: any, _signal?: unknown, _onUpdate?: unknown, ctx?: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured, so nothing was recalled.", { connected: false });
			}
			const projection = await current.bridge.recallNow(params.query, `tool-recall:${Date.now()}`);
			if (!projection) {
				announce(ctx, "mengpo: 记忆获取失败（模型主动召回）");
				return toolResult("Memory service is unavailable; continue without it.", { connected: false });
			}
			announce(ctx, `mengpo: 记忆获取 ${projection.items.length} 条（模型主动召回）`);
			const text = projection.items.length > 0 ? projection.items.map((item) => item.text).join("\n") : "No relevant memory found.";
			return toolResult(text, { connected: true, mode: projection.mode, memoryIds: projection.items.map((item) => item.memoryId) });
		},
	});

	pi.registerTool({
		name: "memory_remember",
		label: "Remember",
		description:
			"Persist a durable fact, preference, or convention to Mengpo long-term memory so later sessions can recall it. Use whenever the user states something durable or asks you to remember.",
		promptSnippet: "memory_remember: persist a durable preference, convention, or explicit instruction",
		promptGuidelines: [
			"Call memory_remember in the same turn whenever the user states a durable preference, project convention, or decision, or explicitly asks you to remember something.",
			"Send one focused fact per call, and skip one-off or easily re-derived details.",
		],
		parameters: REMEMBER_PARAMS,
		execute: async (_id: string, params: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured; nothing was stored.", { stored: false });
			}
			await current.bridge.remember(params.text, contentKey("remember", params.text));
			return toolResult("Recorded for review by the memory service.", { stored: true });
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Forget",
		description:
			"Retire a memory in Mengpo that is stale or no longer true so it stops being recalled. Use when the user says a stored fact no longer applies.",
		promptSnippet: "memory_forget: retire a stale or no-longer-true memory",
		promptGuidelines: [
			"Call memory_forget when the user says a previously stored fact, preference, or instruction is no longer valid.",
		],
		parameters: REMEMBER_PARAMS,
		execute: async (_id: string, params: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured; nothing was changed.", { stored: false });
			}
			await current.bridge.forget(params.text, contentKey("forget", params.text));
			return toolResult("Forgotten request recorded.", { stored: true });
		},
	});

	pi.registerTool({
		name: "memory_correct",
		label: "Correct memory",
		description:
			"Report that a memory Mengpo injected into this session is wrong so the service can correct it. Pass the memory_id from the injected memory.",
		promptSnippet: "memory_correct: report an injected memory that is wrong",
		promptGuidelines: [
			"Call memory_correct with the injected memory_id when the user says an injected memory is inaccurate.",
		],
		parameters: CORRECT_PARAMS,
		execute: async (_id: string, params: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured; nothing was reported.", { reported: false });
			}
			const sent = await current.bridge.feedback(params.memory_id, "corrected", params.reason ?? params.text, `correct:${params.memory_id}`);
			return toolResult(sent ? "Correction reported." : "Could not report the correction; continuing without it.", { reported: sent });
		},
	});
}

function toolResult(text: string, details: Record<string, unknown>): unknown {
	return { content: [{ type: "text", text }], details };
}

/** report writes to the UI when one exists, and to stderr otherwise. */
function report(ctx: any, line: string): void {
	if (ctx?.hasUI && ctx?.ui?.notify) {
		ctx.ui.notify(line, "info");
		return;
	}
	// JSON and print modes own stdout, so a status line goes to stderr there.
	process.stderr.write(`${line}\n`);
}

/** announce surfaces a memory event to the person, in the UI or on stderr. */
function announce(ctx: any, line: string): void {
	report(ctx, line);
}

/** announceDebug adds noisy skip messages only when debugging is enabled. */
function announceDebug(ctx: any, line: string): void {
	if (process.env.MENGPO_PI_DEBUG === "1") {
		report(ctx, line);
	}
}

/** lastUserMessageIndex returns the index of the current turn's user message. */
function lastUserMessageIndex(messages: any[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			return index;
		}
	}
	return -1;
}

/**
 * messageKey identifies a user message across requests. Agent messages are cloned
 * for every request but keep their timestamp, so it is stable for a session. An
 * absent timestamp yields no key, which safely opts the message out of injection.
 */
function messageKey(message: any): string {
	const timestamp = message?.timestamp;
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? `t:${timestamp}` : "";
}

/** messageContains reports whether any text part already carries the marker. */
function messageContains(message: any, marker: string): boolean {
	const content = message?.content;
	if (typeof content === "string") {
		return content.includes(marker);
	}
	if (Array.isArray(content)) {
		return content.some((part: any) => typeof part?.text === "string" && part.text.includes(marker));
	}
	return false;
}

/** appendText adds an injection block to a message's content in place of a new part. */
function appendText(content: any, text: string): any {
	if (typeof content === "string") {
		return content === "" ? text : `${content}\n\n${text}`;
	}
	if (Array.isArray(content)) {
		return [...content, { type: "text", text }];
	}
	return [{ type: "text", text }];
}

/** summaryText reads a compaction or branch summary entry's text, if any. */
function summaryText(entry: any): string {
	const summary = entry?.summary;
	return typeof summary === "string" ? summary.trim() : "";
}

/** idOf reads an entry's identifier, if any. */
function idOf(entry: any): string | undefined {
	const id = entry?.id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/** triggerLabel turns the internal trigger name into a human-facing phrase. */
function triggerLabel(trigger: string): string {
	switch (trigger) {
		case "new-user-request":
			return "新用户输入";
		case "task-switch":
			return "任务切换";
		case "repeated-failures":
			return "连续失败";
		case "explicit-request":
			return "显式请求";
		case "safe-default":
			return "安全默认";
		default:
			return trigger;
	}
}

function safeSessionId(ctx: any): string {
	try {
		return ctx?.sessionManager?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
}

function safeLeafId(ctx: any): string | undefined {
	try {
		const id = ctx?.sessionManager?.getLeafId?.();
		return typeof id === "string" && id !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** safeBranch returns the active session path, or an empty list on any failure. */
function safeBranch(ctx: any): any[] {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

/** parentEntryId reads the real parent link for an entry, if the entry exists. */
function parentEntryId(ctx: any, entryId: string | undefined): string | undefined {
	if (!entryId) {
		return undefined;
	}
	try {
		const entry = ctx?.sessionManager?.getEntry?.(entryId);
		const parent = entry?.parentId;
		return typeof parent === "string" && parent !== "" ? parent : undefined;
	} catch {
		return undefined;
	}
}

/** sequenceFromBranch is the entry's ordinal on the active path, or undefined. */
function sequenceFromBranch(branch: any[], entryId: string | undefined): number | undefined {
	if (!entryId) {
		return undefined;
	}
	const index = branch.findIndex((entry) => entry?.id === entryId);
	return index >= 0 ? index : undefined;
}

function textOf(value: any): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	const content = value.content;
	if (Array.isArray(content)) {
		return content
			.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
			.join("\n")
			.trim();
	}
	if (Array.isArray(value)) {
		return value
			.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
			.join("\n")
			.trim();
	}
	return "";
}

export { renderInjection, EVENT_TYPES };

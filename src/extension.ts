/**
 * pi extension entry point.
 *
 * Wires pi's lifecycle into the memory bridge. Nothing long-lived is created at
 * load time: the client and the session binding are established in
 * `session_start` and released in `session_shutdown`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CircuitBreaker } from "./breaker.ts";
import { MemoryClient } from "./client.ts";
import { resolveAccess, scrub, type AccessConfig } from "./config.ts";
import { INJECTION_TAG, MemoryBridge, renderInjection, truncate } from "./memory.ts";
import { detectExplicitRecall, detectTaskSwitch } from "./recall.ts";
import { EVENT_TYPES } from "./trace.ts";

export const USER_CONFIG_PATH = join(homedir(), ".pi", "mengpo.json");

/** Load the optional user configuration file. A missing file is not an error. */
export function loadUserConfig(path: string = USER_CONFIG_PATH): Partial<Record<string, string>> {
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
		previousCwd = undefined;
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
			// Appending a prompt section keeps pi's transcript delta and cached
			// prefix intact; replacing the whole system prompt would not.
			const sections = event.systemPromptOptions?.sections;
			if (sections && typeof sections === "object") {
				sections[INJECTION_TAG] = outcome.injection;
				announce(ctx, `mengpo: 记忆注入 ${outcome.itemCount} 条`);
			}
		}
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

	pi.on("session_shutdown", async () => {
		// Idempotent: cancellation, reload, session replacement and exit can all
		// converge here.
		state = undefined;
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
		description: "Look up long-term memory for a query. Use when earlier experience may be relevant.",
		promptSnippet: "memory_recall: look up long-term memory",
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
		description: "Ask Mengpo to keep a durable memory. Use for explicit instructions worth carrying across sessions.",
		promptSnippet: "memory_remember: keep a durable memory",
		parameters: REMEMBER_PARAMS,
		execute: async (_id: string, params: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured; nothing was stored.", { stored: false });
			}
			await current.bridge.remember(params.text, `remember:${Date.now()}`);
			return toolResult("Recorded for review by the memory service.", { stored: true });
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Forget",
		description: "Ask Mengpo to drop a memory. Use when something is stale or should no longer be recalled.",
		promptSnippet: "memory_forget: drop a memory",
		parameters: REMEMBER_PARAMS,
		execute: async (_id: string, params: any) => {
			const current = state;
			if (!current) {
				return toolResult("Memory is not configured; nothing was changed.", { stored: false });
			}
			await current.bridge.forget(params.text, `forget:${Date.now()}`);
			return toolResult("Forgotten request recorded.", { stored: true });
		},
	});

	pi.registerTool({
		name: "memory_correct",
		label: "Correct memory",
		description: "Report that an injected memory is wrong, so the service can correct it.",
		promptSnippet: "memory_correct: report a wrong memory",
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

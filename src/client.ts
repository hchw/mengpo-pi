/**
 * HTTP client for the Mengpo command surface.
 *
 * The client keeps the session cookie itself (Node's fetch does not), never logs
 * the credential, and degrades rather than blocking: every call is bounded by a
 * timeout and reports failures as values the caller can ignore.
 */

import { buildEnvelope, type Envelope, type MemoryHint, type ScopeType } from "./envelope.ts";

export interface ClientOptions {
	baseUrl: string;
	assertion: string;
	tenantId?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
	newId?: () => string;
}

export interface ApiFailure {
	code: string;
	message: string;
	status: number;
}

export class ApiError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(failure: ApiFailure) {
		super(failure.message);
		this.name = "ApiError";
		this.code = failure.code;
		this.status = failure.status;
	}
}

export interface SessionContext {
	tenantId: string;
	userId: string;
	roles: string[];
}

export interface ObserveRequest {
	scopeType: ScopeType;
	sessionId?: string;
	idempotencyKey: string;
	payload: Record<string, unknown>;
}

export interface ProjectRequest {
	scopeType: ScopeType;
	sessionId?: string;
	idempotencyKey: string;
	query: string;
	memoryHint?: MemoryHint;
	scenario?: Record<string, unknown>;
}

export interface ProjectionItem {
	text: string;
	memoryId: string;
}

export interface ProjectionResult {
	projectionId?: string;
	items: ProjectionItem[];
	mode: string;
	degraded: boolean;
}

export interface FeedbackRequest {
	scopeType: ScopeType;
	sessionId?: string;
	idempotencyKey: string;
	memoryId: string;
	type: string;
	reason?: string;
}

export class MemoryClient {
	private readonly baseUrl: string;
	private readonly assertion: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly newId: () => string;
	private cookie?: string;
	private configuredTenantId: string;
	private context?: SessionContext;

	constructor(options: ClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.assertion = options.assertion;
		this.configuredTenantId = options.tenantId ?? "";
		this.timeoutMs = options.timeoutMs ?? 2000;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? (() => crypto.randomUUID());
	}

	get tenantContext(): SessionContext | undefined {
		return this.context;
	}

	/** enroll exchanges the assertion for a session and selects a tenant. */
	async enroll(): Promise<SessionContext> {
		const exchanged = await this.post("/api/v1/auth/sso/exchange", { assertion: this.assertion });
		const data = exchanged as { user?: { id?: string }; tenants?: Array<{ id?: string; active?: boolean }> };
		const tenantId = this.configuredTenantId || pickTenant(data.tenants);
		if (!tenantId) {
			throw new ApiError({ code: "NO_TENANT", message: "no accessible tenant", status: 200 });
		}
		const active = (await this.post("/api/v1/auth/tenant-context", { tenant_id: tenantId })) as {
			tenant_id?: string;
			user_id?: string;
			roles?: string[];
		};
		this.context = {
			tenantId: active.tenant_id ?? tenantId,
			userId: active.user_id ?? data.user?.id ?? "",
			roles: active.roles ?? [],
		};
		return this.context;
	}

	/** ensureSession selects the tenant once, then reuses the resulting context. */
	async ensureSession(): Promise<SessionContext> {
		if (this.context) {
			return this.context;
		}
		return this.enroll();
	}

	async bindSession(externalId: string, title: string): Promise<string> {
		const context = await this.ensureSession();
		const response = (await this.command("session", {
			scopeType: "user-global",
			idempotencyKey: `session:${externalId}`,
			payload: { external_id: externalId, title },
		})) as { session_id?: string };
		if (!response.session_id) {
			throw new ApiError({ code: "NO_SESSION", message: "session binding returned no identifier", status: 200 });
		}
		// The bound session is what makes session-scoped memories reachable later.
		this.context = { ...context, tenantId: context.tenantId };
		return response.session_id;
	}

	async observe(request: ObserveRequest): Promise<{ eventId: string; created: boolean }> {
		try {
			const response = (await this.command("observe", request)) as { event_id?: string; created?: boolean };
			return { eventId: response.event_id ?? "", created: response.created ?? false };
		} catch (error) {
			// A server that predates the deep-runtime ingress rejects the whole
			// request on its new fields. The observation still has value without
			// them, so retry once in the pre-ingress shape instead of letting the
			// reporting path stay broken.
			if (isUnknownFieldRejection(error) && hasIngressObserveFields(request.payload)) {
				const response = (await this.command("observe", {
					...request,
					payload: toLegacyObservePayload(request.payload),
				})) as { event_id?: string; created?: boolean };
				return { eventId: response.event_id ?? "", created: response.created ?? false };
			}
			throw error;
		}
	}

	async project(request: ProjectRequest): Promise<ProjectionResult> {
		try {
			return parseProjection(await this.command("project", request));
		} catch (error) {
			// A server that predates the scenario entry rejects the field and would
			// lose the whole recall. Drop it once: depth then falls back to the
			// service default, which is still useful.
			if (isUnknownFieldRejection(error) && request.scenario && Object.keys(request.scenario).length > 0) {
				return parseProjection(await this.command("project", { ...request, scenario: undefined }));
			}
			throw error;
		}
	}

	async feedback(request: FeedbackRequest): Promise<void> {
		await this.command("feedback", { ...request, payload: { memory_id: request.memoryId, type: request.type, reason: request.reason ?? "" } });
	}

	/** command runs one envelope-carrying command and returns its data body. */
	private async command(
		operation: "observe" | "project" | "feedback" | "session",
		request: {
			scopeType: ScopeType;
			sessionId?: string;
			idempotencyKey: string;
			payload?: Record<string, unknown>;
			query?: string;
			memoryHint?: MemoryHint;
			scenario?: Record<string, unknown>;
		},
	): Promise<unknown> {
		const context = await this.ensureSession();
		let payload: Record<string, unknown>;
		let memoryHint = request.memoryHint;
		if (operation === "session") {
			payload = request.payload ?? {};
		} else if (operation === "project") {
			payload = { query: request.query ?? "" };
			if (request.scenario && Object.keys(request.scenario).length > 0) {
				payload.scenario = request.scenario;
			}
		} else if (operation === "feedback") {
			payload = request.payload ?? {};
		} else {
			payload = request.payload ?? {};
		}
		if (operation === "observe" && request.payload?.memory_intent === true) {
			memoryHint = memoryHint ?? { mode: "auto" };
		}
		const envelope = buildEnvelope({
			tenantId: context.tenantId,
			userId: context.userId,
			principalId: context.userId,
			principalType: "user",
			scopeType: request.scopeType,
			sessionId: request.sessionId,
			requestId: this.newId(),
			idempotencyKey: request.idempotencyKey,
			payload,
			memoryHint,
			visibility: "private",
		});
		return this.post(`/api/v1/${commandPath(operation)}`, envelope);
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const response = await this.request(path, body);
		return response;
	}

	private async request(path: string, body: unknown): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (this.cookie) {
				headers.Cookie = this.cookie;
			}
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			this.rememberCookie(response);
			const text = await response.text();
			const decoded = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
			if (!response.ok) {
				const failure = (decoded.error ?? {}) as { code?: string; message?: string };
				throw new ApiError({
					code: failure.code ?? "HTTP_ERROR",
					message: failure.message ?? `request failed with status ${response.status}`,
					status: response.status,
				});
			}
			return decoded.data ?? {};
		} finally {
			clearTimeout(timer);
		}
	}

	private rememberCookie(response: Response): void {
		const headers = response.headers as Headers & { getSetCookie?: () => string[] };
		const raw = headers.getSetCookie?.() ?? [];
		const single = response.headers.get("set-cookie");
		const candidates = raw.length > 0 ? raw : single ? [single] : [];
		for (const candidate of candidates) {
			const pair = candidate.split(";")[0]?.trim();
			if (pair && pair.includes("=")) {
				this.cookie = pair;
			}
		}
	}
}

// commandPath maps a command to its route. Session binding lives at the plural
// collection route; the singular path is reserved for the agent command surface.
function commandPath(operation: "observe" | "project" | "feedback" | "session"): string {
	return operation === "session" ? "sessions" : operation;
}

function pickTenant(tenants: Array<{ id?: string; active?: boolean }> | undefined): string {
	if (!tenants || tenants.length === 0) {
		return "";
	}
	const active = tenants.find((tenant) => tenant.active);
	return (active ?? tenants[0]).id ?? "";
}

/** Fields introduced with the deep-runtime ingress; absent on older servers. */
const INGRESS_OBSERVE_FIELDS = ["source_type", "sequence", "parent_event_id", "trace"] as const;

function hasIngressObserveFields(payload: Record<string, unknown>): boolean {
	return INGRESS_OBSERVE_FIELDS.some((field) => field in payload);
}

/** toLegacyObservePayload keeps only fields a pre-ingress server understands. */
function toLegacyObservePayload(payload: Record<string, unknown>): Record<string, unknown> {
	const legacy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if ((INGRESS_OBSERVE_FIELDS as readonly string[]).includes(key)) {
			continue;
		}
		legacy[key] = value;
	}
	return legacy;
}

/** parseProjection maps the service response body onto the projection shape. */
function parseProjection(response: unknown): ProjectionResult {
	const body = response as {
		projection_id?: string;
		items?: Array<{ Candidate?: { Node?: { ID?: string } }; Text?: string }>;
		metadata?: { mode?: string; degraded?: boolean };
	};
	const items: ProjectionItem[] = [];
	for (const item of body.items ?? []) {
		const text = item.Text ?? "";
		if (text.trim() === "") {
			continue;
		}
		items.push({ text, memoryId: item.Candidate?.Node?.ID ?? "" });
	}
	return {
		projectionId: body.projection_id,
		items,
		mode: body.metadata?.mode ?? "unknown",
		degraded: body.metadata?.degraded ?? false,
	};
}

function isUnknownFieldRejection(error: unknown): boolean {
	return error instanceof ApiError && error.code === "INVALID_ENVELOPE";
}

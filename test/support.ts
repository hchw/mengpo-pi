/**
 * Test support: a fake fetch and response objects, so client and bridge tests
 * can assert on the exact requests the adapter would send.
 */

export interface RecordedCall {
	url: string;
	method: string;
	body: any;
	headers: Record<string, string>;
}

export interface FakeResponseInit {
	status?: number;
	data?: unknown;
	error?: { code: string; message: string };
	setCookie?: string;
	rawBody?: string;
}

export function jsonResponse(init: FakeResponseInit = {}): Response {
	const status = init.status ?? 200;
	const body =
		init.rawBody !== undefined
			? init.rawBody
			: JSON.stringify(
					init.error ? { version: "v1", error: init.error } : { version: "v1", data: init.data ?? {} },
				);
	const setCookies = init.setCookie ? [init.setCookie] : [];
	const response = {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) => (name.toLowerCase() === "set-cookie" && init.setCookie ? init.setCookie : null),
			getSetCookie: () => setCookies,
		},
		text: async () => body,
	};
	return response as unknown as Response;
}

export interface FetchPlan {
	/** Handler per URL path; the first match wins. */
	handler: (path: string, call: RecordedCall) => Response | Promise<Response>;
}

export interface FakeFetch {
	fetch: typeof fetch;
	calls: RecordedCall[];
	paths: () => string[];
}

export function createFetch(plan: FetchPlan): FakeFetch {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: any, init: any = {}) => {
		const url = typeof input === "string" ? input : String(input?.url ?? input);
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const call: RecordedCall = {
			url,
			method: init.method ?? "GET",
			body: init.body ? JSON.parse(String(init.body)) : undefined,
			headers: (init.headers ?? {}) as Record<string, string>,
		};
		calls.push(call);
		return plan.handler(path, call);
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls, paths: () => calls.map((call) => new URL(call.url).pathname) };
}

/** A minimal happy-path server: enroll, tenant context, and per-command data. */
export function defaultServer(overrides: Partial<Record<string, (call: RecordedCall) => Response>> = {}) {
	return (path: string, call: RecordedCall): Response => {
		const override = overrides[path];
		if (override) {
			return override(call);
		}
		switch (path) {
			case "/api/v1/auth/sso/exchange":
				return jsonResponse({
					data: { user: { id: "user-1", email: "dev@mengpo.local" }, tenants: [{ id: "tenant-1", active: true }] },
					setCookie: "mengpo_session=token-1; Path=/; HttpOnly",
				});
			case "/api/v1/auth/tenant-context":
				return jsonResponse({ data: { tenant_id: "tenant-1", user_id: "user-1", roles: ["tenant-admin"] } });
			case "/api/v1/sessions":
				return jsonResponse({ data: { session_id: "session-1", tenant_id: "tenant-1" } });
			case "/api/v1/observe":
				return jsonResponse({ data: { event_id: "event-1", created: true } });
			case "/api/v1/project":
				return jsonResponse({
					data: {
						projection_id: "projection-1",
						items: [{ Text: "pgvector keeps the index local", Candidate: { Node: { ID: "memory-1" } } }],
						metadata: { mode: "focus", degraded: false },
					},
				});
			case "/api/v1/feedback":
				return jsonResponse({ data: { stored: true } });
			default:
				return jsonResponse({ status: 404, error: { code: "NOT_FOUND", message: `no route for ${path}` } });
		}
	};
}

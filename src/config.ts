/**
 * Access configuration for the Mengpo memory service.
 *
 * The extension is inert until access is configured: with no base URL or no
 * credential it must not issue any call, and must not retry on every turn.
 */

export interface AccessConfig {
	baseUrl: string;
	assertion: string;
	tenantId: string;
	timeoutMs: number;
	cookieName?: string;
}

export interface ConfigSource {
	env?: Record<string, string | undefined>;
	file?: Partial<Record<string, string>> | undefined;
}

export const ENV_KEYS = {
	baseUrl: "MENGPO_PI_BASE_URL",
	assertion: "MENGPO_PI_ASSERTION",
	tenantId: "MENGPO_PI_TENANT",
	timeoutMs: "MENGPO_PI_TIMEOUT_MS",
} as const;

export const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_TIMEOUT_MS = 30_000;

/**
 * resolveAccess returns undefined when the extension is not configured. That is
 * a normal state, not an error: an unconfigured extension stays completely
 * inert.
 */
export function resolveAccess(source: ConfigSource = {}): AccessConfig | undefined {
	const env = source.env ?? {};
	const file = source.file ?? {};
	const baseUrl = (env[ENV_KEYS.baseUrl] ?? file.baseUrl ?? "").trim();
	const assertion = (env[ENV_KEYS.assertion] ?? file.assertion ?? "").trim();
	if (baseUrl === "" || assertion === "") {
		return undefined;
	}
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		assertion,
		tenantId: (env[ENV_KEYS.tenantId] ?? file.tenantId ?? "").trim(),
		timeoutMs: resolveTimeout(env[ENV_KEYS.timeoutMs] ?? file.timeoutMs),
	};
}

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function resolveTimeout(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_TIMEOUT_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(parsed, MAX_TIMEOUT_MS);
}

/**
 * A credential must never appear in logs or in content shown to the model.
 * Callers use this to redact values before they are emitted anywhere.
 */
export function redact(value: string | undefined): string {
	if (!value) {
		return "";
	}
	if (value.length <= 8) {
		return "***";
	}
	return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/** Scrub a credential out of an arbitrary string (log lines, error messages). */
export function scrub(text: string, secret: string | undefined): string {
	if (!secret || secret.length < 8) {
		return text;
	}
	return text.split(secret).join(redact(secret));
}

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TIMEOUT_MS, ENV_KEYS, redact, resolveAccess, scrub } from "../src/config.ts";

test("an unconfigured extension resolves to no access at all", () => {
	assert.equal(resolveAccess({ env: {} }), undefined);
	assert.equal(resolveAccess({ env: { [ENV_KEYS.baseUrl]: "http://localhost:8080" } }), undefined);
	assert.equal(resolveAccess({ env: { [ENV_KEYS.assertion]: "dev@mengpo.local" } }), undefined);
});

test("access resolves from the environment and trims trailing slashes", () => {
	const config = resolveAccess({
		env: {
			[ENV_KEYS.baseUrl]: "http://localhost:8080/",
			[ENV_KEYS.assertion]: " dev@mengpo.local ",
			[ENV_KEYS.tenantId]: "tenant-1",
		},
	});
	assert.equal(config?.baseUrl, "http://localhost:8080");
	assert.equal(config?.assertion, "dev@mengpo.local");
	assert.equal(config?.tenantId, "tenant-1");
	assert.equal(config?.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("the file configuration only fills what the environment leaves empty", () => {
	const config = resolveAccess({
		env: { [ENV_KEYS.baseUrl]: "http://env:8080", [ENV_KEYS.assertion]: "env-assertion" },
		file: { baseUrl: "http://file:8080", assertion: "file-assertion", tenantId: "file-tenant" },
	});
	assert.equal(config?.baseUrl, "http://env:8080");
	assert.equal(config?.assertion, "env-assertion");
	assert.equal(config?.tenantId, "file-tenant");
});

test("an unusable timeout falls back and a huge one is capped", () => {
	assert.equal(resolveAccess({ env: { [ENV_KEYS.baseUrl]: "http://x", [ENV_KEYS.assertion]: "a", [ENV_KEYS.timeoutMs]: "nonsense" } })?.timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAccess({ env: { [ENV_KEYS.baseUrl]: "http://x", [ENV_KEYS.assertion]: "a", [ENV_KEYS.timeoutMs]: "-5" } })?.timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAccess({ env: { [ENV_KEYS.baseUrl]: "http://x", [ENV_KEYS.assertion]: "a", [ENV_KEYS.timeoutMs]: "900000" } })?.timeoutMs, 30_000);
});

test("a credential never appears verbatim in a redacted value", () => {
	const secret = "dev@mengpo.local-secret";
	assert.equal(redact(secret).includes(secret), false);
	assert.equal(redact("short"), "***");
	assert.equal(scrub(`login failed for ${secret}`, secret).includes(secret), false);
	assert.equal(scrub("nothing to hide", secret), "nothing to hide");
});

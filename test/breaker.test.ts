import assert from "node:assert/strict";
import test from "node:test";

import { CircuitBreaker } from "../src/breaker.ts";

test("the breaker stays closed until the failure threshold is reached", () => {
	const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => 0 });
	assert.equal(breaker.allows(), true);
	breaker.recordFailure();
	breaker.recordFailure();
	assert.equal(breaker.allows(), true);
	breaker.recordFailure();
	assert.equal(breaker.allows(), false);
	assert.equal(breaker.isOpen(), true);
});

test("a success resets the run of failures", () => {
	const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => 0 });
	breaker.recordFailure();
	breaker.recordSuccess();
	breaker.recordFailure();
	assert.equal(breaker.allows(), true);
	assert.equal(breaker.failureCount, 1);
});

test("the breaker lets one probe through after the cooldown", () => {
	let now = 0;
	const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
	breaker.recordFailure();
	assert.equal(breaker.allows(), false);
	now = 999;
	assert.equal(breaker.allows(), false);
	now = 1000;
	assert.equal(breaker.allows(), true);
	breaker.recordFailure();
	assert.equal(breaker.allows(), false);
});

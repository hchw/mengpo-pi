/**
 * Circuit breaker for memory access.
 *
 * Memory is a side channel: when the service is down, the session must neither
 * slow down nor fill its logs with the same failure every turn. After a run of
 * consecutive failures the extension stops trying for a cooldown, then probes
 * once.
 */

export interface BreakerOptions {
	failureThreshold?: number;
	cooldownMs?: number;
	now?: () => number;
}

export class CircuitBreaker {
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private failures = 0;
	private openedAt: number | undefined;

	constructor(options: BreakerOptions = {}) {
		this.failureThreshold = options.failureThreshold ?? 3;
		this.cooldownMs = options.cooldownMs ?? 30_000;
		this.now = options.now ?? Date.now;
	}

	/** allows reports whether a call may be attempted right now. */
	allows(): boolean {
		if (this.openedAt === undefined) {
			return true;
		}
		if (this.now() - this.openedAt >= this.cooldownMs) {
			// Cooldown elapsed: allow exactly one probing call.
			return true;
		}
		return false;
	}

	recordSuccess(): void {
		this.failures = 0;
		this.openedAt = undefined;
	}

	recordFailure(): void {
		this.failures += 1;
		if (this.failures >= this.failureThreshold) {
			this.openedAt = this.now();
		}
	}

	isOpen(): boolean {
		return this.openedAt !== undefined && !this.allows();
	}

	get failureCount(): number {
		return this.failures;
	}
}

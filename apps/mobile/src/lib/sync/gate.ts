/**
 * The outbox is suspended while a sync pull applies pages.
 *
 * A page is applied in one synchronous transaction, so no JavaScript can run inside it; what the
 * gate orders is the ASYNCHRONOUS work around it. The pull holds the gate from its first request
 * to its last commit (a 410 reset included), and the outbox drain waits for the gate before it
 * takes each item, so a drained mutation is never written between a reset and the snapshot that
 * follows it, and the two never contend for the connection's write lock.
 */

export class ApplyGate {
  private holders = 0;
  private waiters: (() => void)[] = [];

  get busy(): boolean {
    return this.holders > 0;
  }

  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.holders += 1;
    try {
      return await work();
    } finally {
      this.holders -= 1;
      if (this.holders === 0) {
        for (const resolve of this.waiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  /** Resolves when no pull holds the gate. */
  idle(): Promise<void> {
    if (!this.busy) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

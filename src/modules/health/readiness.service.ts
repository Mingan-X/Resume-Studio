export class ReadinessService {
  private active: Promise<boolean> | undefined;
  private cached: { ready: boolean; until: number } | undefined;
  constructor(private readonly database: () => Promise<void>, private readonly broker: () => Promise<void>) {}
  async check(): Promise<boolean> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.ready;
    if (this.active) return this.active;
    this.active = (async () => {
      const results = await Promise.allSettled([this.database(), this.broker()]);
      const ready = results.every(result => result.status === 'fulfilled');
      this.cached = { ready, until: Date.now() + 1000 }; return ready;
    })();
    try { return await this.active; } finally { this.active = undefined; }
  }
}

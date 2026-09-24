import type { TranslationAdapterFactory } from './types.js';

export type FactoryBuilder = () => TranslationAdapterFactory & { dispose?: () => Promise<void> };

/**
 * Holds every configured translation engine and prepares each one lazily on
 * first use (loading a 1 GB model only when a session asks for it). The
 * default engine can be prepared eagerly at startup.
 */
export class TranslationRegistry {
  private readonly builders = new Map<string, FactoryBuilder>();
  private readonly prepared = new Map<string, Promise<TranslationAdapterFactory & { dispose?: () => Promise<void> }>>();

  constructor(readonly defaultProvider: string) {}

  register(name: string, builder: FactoryBuilder): this {
    this.builders.set(name, builder);
    return this;
  }

  /** Names a client may ask for. */
  get providers(): string[] {
    return [...this.builders.keys()];
  }

  has(name: string): boolean {
    return this.builders.has(name);
  }

  /** Resolve (and prepare once) a factory. Rejects with the factory's own actionable error. */
  get(name: string = this.defaultProvider): Promise<TranslationAdapterFactory> {
    const builder = this.builders.get(name);
    if (builder === undefined) return Promise.reject(new Error(`unknown translation provider "${name}" (available: ${this.providers.join(', ')})`));
    let pending = this.prepared.get(name);
    if (pending === undefined) {
      pending = (async () => {
        const factory = builder();
        await factory.prepare();
        return factory;
      })();
      // A failed prepare (e.g. missing key) must be retried next time, not cached.
      pending.catch(() => this.prepared.delete(name));
      this.prepared.set(name, pending);
    }
    return pending;
  }

  async dispose(): Promise<void> {
    for (const p of this.prepared.values()) {
      const f = await p.catch(() => null);
      await f?.dispose?.();
    }
    this.prepared.clear();
  }
}

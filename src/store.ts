// Minimal key/value storage abstraction: a JSON file for the local CLI,
// Cloudflare KV for the Worker.

export interface Store {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
}

export class KVStore implements Store {
  kv: KVNamespace;
  constructor(kv: KVNamespace) {
    this.kv = kv;
  }
  async get<T>(key: string): Promise<T | null> {
    return (await this.kv.get(key, "json")) as T | null;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}

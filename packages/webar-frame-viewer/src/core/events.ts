type Handler<T> = (payload: T) => void;

/** Emissor tipado minimalista. Sem dependências, sem browser. */
export class Emitter<TMap extends Record<string, unknown>> {
  private readonly map = new Map<keyof TMap, Set<Handler<never>>>();

  on<K extends keyof TMap>(type: K, fn: Handler<TMap[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  once<K extends keyof TMap>(type: K, fn: Handler<TMap[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof TMap>(type: K, fn: Handler<TMap[K]>): void {
    this.map.get(type)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof TMap>(type: K, payload: TMap[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    // Cópia: um handler pode chamar off() durante a iteração.
    for (const fn of [...set]) {
      try {
        (fn as Handler<TMap[K]>)(payload);
      } catch (err) {
        console.error('[webar-frame-viewer] handler lançou exceção:', err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

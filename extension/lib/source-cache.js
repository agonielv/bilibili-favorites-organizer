// Read-only video data stays in this page. Changing the batch scope never writes
// to Bilibili and never discards otherwise fresh source data.
export class SourceCache {
  constructor({ ttl = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttl = ttl; this.now = now; this.owner = null; this.entries = new Map(); this.generation = 0;
  }
  clear(owner = this.owner) { this.owner = owner; this.entries.clear(); this.generation++; }
  peek(uid, id) {
    if (uid !== this.owner) return null;
    const entry = this.entries.get(String(id));
    if (entry && this.now() - entry.at < this.ttl) return entry;
    this.entries.delete(String(id)); return null;
  }
  async collect(uid, sources, load) {
    if (uid !== this.owner) this.clear(uid);
    for (const id of this.entries.keys()) this.peek(uid, id);
    const generation = this.generation, entries = [];
    let loaded = 0;
    for (const source of sources) {
      let entry = this.peek(uid, source.id);
      if (!entry) {
        const items = await load(source);
        if (generation !== this.generation || uid !== this.owner) throw new Error('账号或读取状态已变化，请重新连接。');
        entry = { items, at: this.now() }; this.entries.set(String(source.id), entry); loaded++;
      }
      entries.push(entry);
    }
    // Replanning or adding cached sources must not extend the oldest lifetime.
    const at = entries.length ? Math.min(...entries.map(entry => entry.at)) : this.now();
    if (this.now() - at >= this.ttl) throw new Error('部分来源预览已过期，请重新生成预览。');
    return { uid, at, key: sources.map(source => String(source.id)).sort().join(','), items: entries.flatMap(entry => entry.items), loaded };
  }
}

// Read-only video data stays in this page. Changing the batch scope never writes
// to Bilibili. Reads and previews have no wall-clock deadline: a large scan may
// take longer than ten minutes. The runner revalidates sources before any write.
export class SourceCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.owner = null; this.entries = new Map(); this.generation = 0;
  }
  clear(owner = this.owner) { this.owner = owner; this.entries.clear(); this.generation++; }
  peek(uid, id) {
    if (uid !== this.owner) return null;
    return this.entries.get(String(id)) || null;
  }
  async collect(uid, sources, load) {
    if (uid !== this.owner) this.clear(uid);
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
    // Keep the actual read time even when rules change or more sources are added.
    const at = entries.length ? Math.min(...entries.map(entry => entry.at)) : this.now();
    return { uid, at, completedAt: this.now(), key: sources.map(source => String(source.id)).sort().join(','),
      sources: sources.map((source, index) => ({ id: String(source.id), title: String(source.title), count: entries[index].items.length })),
      items: entries.flatMap(entry => entry.items), loaded };
  }
}

// Overall progress is explicitly by source folder, so stale directory counts
// and uneven folder sizes cannot imply a false exact total of video records.
export class ReadProgress {
  constructor(sources, cached = new Map()) {
    this.sources = sources.map(source => ({ id: String(source.id), title: String(source.title),
      expected: Number.isInteger(source.count) && source.count >= 0 ? source.count : null,
      read: cached.get(String(source.id)) ?? 0, page: 0, observed: cached.has(String(source.id)), done: cached.has(String(source.id)) }));
    for (const source of this.sources) if (source.done) source.expected = source.read;
    this.active = this.sources.find(source => !source.done) || this.sources.at(-1);
  }
  update({ source, folder = source, read = 0, expected, page, step = 'page' }) {
    const current = this.sources.find(item => item.id === String(folder.id));
    if (!current) return;
    this.active = current;
    if (step === 'start') { current.done = false; current.observed = false; current.page = 0; }
    current.read = Math.max(0, Number(read) || 0);
    if (Number.isInteger(page) && page >= 0) current.page = page;
    if (expected === null || (Number.isInteger(expected) && expected >= 0)) current.expected = expected;
    if (step !== 'start') current.observed = true;
    if (step === 'complete') { current.done = true; current.expected = current.read; }
  }
  fraction(source) {
    if (source.done) return 1;
    if (source.expected > 0) return Math.min(1, source.read / source.expected);
    return source.expected === 0 && source.observed ? 1 : 0;
  }
  view() {
    const completed = this.sources.filter(source => source.done).length, total = this.sources.length;
    const progress = total ? this.sources.reduce((sum, source) => sum + this.fraction(source), 0) / total : 0;
    // The last received page is not yet a validated source or completed stage.
    const percent = Math.min(completed === total && total ? 100 : 99, Math.floor(progress * 100));
    const current = this.active;
    return { completed, total, percent, current: current ? { ...current,
      percent: current.expected === null ? null : Math.floor(this.fraction(current) * 100) } : null };
  }
}

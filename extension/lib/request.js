export class ApiError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ApiError'; Object.assign(this, details); }
}
export const COOLDOWN_KEY = 'apiCooldownUntil';
const RISK_CODES = new Set([-352, -412, -509, 429]);
export class RequestQueue {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), storage, interval = 1200, timeout = 30000 }) {
    Object.assign(this, { fetcher, now, sleep, storage, interval, timeout });
    this.tail = Promise.resolve(); this.lastAt = -Infinity; this.cooldownUntil = 0;
  }
  async cooldown() {
    const saved = Number(await this.storage.get(COOLDOWN_KEY));
    if (Number.isFinite(saved)) this.cooldownUntil = Math.max(this.cooldownUntil, saved);
    return this.cooldownUntil;
  }
  cooldownError(details = {}) {
    const seconds = Math.max(1, Math.ceil((this.cooldownUntil - this.now()) / 1000));
    return new ApiError(`B 站接口触发限流或风控，已停止请求。至少 ${seconds} 秒后才允许尝试；请勿连续执行或刷新。服务端实际恢复时间可能更长。`, { rateLimited: true, retryable: false, ...details });
  }
  async block(retryAfter, details) {
    const seconds = Number(retryAfter);
    const parsed = retryAfter ? (Number.isFinite(seconds) ? this.now() + seconds * 1000 : Date.parse(retryAfter)) : 0;
    this.cooldownUntil = Math.max(await this.cooldown(), this.now() + 60000, Number.isFinite(parsed) ? parsed : 0);
    // Persistence is required so another manager/reload cannot immediately restart the flood.
    try { await this.storage.set(COOLDOWN_KEY, this.cooldownUntil); }
    catch { return new ApiError('B 站触发限流，且无法保存冷却状态。请停止使用扩展并等待服务恢复。', { rateLimited: true, retryable: false }); }
    return this.cooldownError(details);
  }
  request(url, makeInit) {
    const result = this.tail.then(async () => {
      if (await this.cooldown() > this.now()) throw this.cooldownError();
      const wait = this.interval - (this.now() - this.lastAt);
      if (wait > 0) await this.sleep(wait);
      if (await this.cooldown() > this.now()) throw this.cooldownError();
      const init = await makeInit();
      const write = init.method === 'POST';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      this.lastAt = this.now();
      try {
        const response = await this.fetcher(url, { ...init, credentials: 'include', signal: controller.signal });
        if ([412, 429].includes(response.status)) throw await this.block(response.headers.get('Retry-After'), { status: response.status });
        if (!response.ok) throw new ApiError(`B 站接口返回 HTTP ${response.status}。${write ? '该写入是否生效尚不确定，请核对收藏夹后再操作。' : '请稍后再试。'}`, { status: response.status, retryable: !write && response.status >= 500, ambiguousWrite: write });
        const body = await response.json();
        if (typeof body.code !== 'number') throw new ApiError('接口返回格式异常。', { retryable: !write, ambiguousWrite: write });
        if (body.code !== 0) {
          const message = String(body.message || body.msg || '未知错误');
          if (RISK_CODES.has(body.code) || /请求过于频繁|访问过于频繁|操作太频繁|风控/.test(message)) throw await this.block(response.headers.get('Retry-After'), { code: body.code });
          throw new ApiError(`B 站接口错误 ${body.code}：${message}`, { code: body.code, retryable: false, rejected: true });
        }
        return body.data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(write ? '网络异常或响应超时，移动 / 创建是否已生效无法确定，已停止以避免重复写入。请核对收藏夹。' : '网络异常或响应超时，请检查连接。', { retryable: !write, ambiguousWrite: write });
      } finally { clearTimeout(timer); }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async read(action) {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (!error.retryable || attempt >= 2) throw error;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }
}

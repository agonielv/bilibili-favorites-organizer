import { ApiError } from './request.js';
import { normalizeMedia } from './planner.js';
const ROOT = 'https://api.bilibili.com/x/v3/fav/';
export class BiliClient {
  constructor(queue, checkSession) { this.queue = queue; this.checkSession = checkSession; this.pageSize = 100; }
  async request(path, { params, form } = {}) {
    const url = ROOT + path + (params ? '?' + new URLSearchParams(params) : '');
    const action = () => this.queue.request(url, async () => {
      const session = await this.checkSession();
      if (form) return { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: new URLSearchParams({ ...form, csrf: session.csrf, ...(form.csrf_token !== undefined ? { csrf_token: session.csrf } : {}) }).toString() };
      return { method: 'GET', headers: { Accept: 'application/json' } };
    });
    return form ? action() : this.queue.read(action);
  }
  async folders(uid) {
    if (!uid) uid = (await this.checkSession()).uid;
    const data = await this.request('folder/created/list-all', { params: { up_mid: uid, type: '2', rid: '0' } });
    if (data?.list === null || (data && Number(data.count) === 0 && !data.list)) return [];
    if (!Array.isArray(data?.list)) throw new Error('收藏夹列表返回格式异常，请稍后重试。');
    if (data.list.some(f => !/^\d+$/.test(String(f.id)) || !f.id)) throw new Error('收藏夹 ID 返回异常。');
    return data.list.map(f => ({ id: String(f.id), title: String(f.title), count: Number(f.media_count) || 0 }));
  }
  async page(folder, pn = 1) {
    const requested = this.pageSize;
    let data;
    try {
      data = await this.request('resource/list', { params: { media_id: folder.id, pn: String(pn), ps: String(requested), keyword: '', order: 'mtime', type: '0', tid: '0', platform: 'web' } });
    } catch (error) {
      if (pn !== 1 || requested <= 20 || !error.rejected || error.code !== -400 || error.rateLimited) throw error;
      this.pageSize = 20;
      return this.page(folder, 1);
    }
    const count = Number(data?.info?.media_count);
    if (!data?.info || !Number.isInteger(count) || count < 0 || (data.medias != null && !Array.isArray(data.medias))) throw new Error(`收藏夹“${folder.title}”返回数据异常，已停止读取。`);
    const length = (data.medias || []).length;
    const more = data.has_more === true || data.has_more === 1 || data.has_more === '1';
    if (length > requested) throw new Error('接口返回的分页大小异常，已停止读取。');
    if (length > 0 && length < requested && (more || (pn - 1) * requested + length < count)) {
      if (pn !== 1) throw new Error('分页大小在读取期间变化，请重新读取，避免跳过视频。');
      // A server may silently clamp ps=100 to 20. Continue at the observed size
      // so pn=2 starts exactly after the records already read, never at offset 100.
      this.pageSize = length;
    }
    return { items: (data.medias || []).map(media => normalizeMedia(media, folder)), count,
      more: data.has_more === true || data.has_more === 1 || data.has_more === '1' };
  }
  inspect(folder) { return this.page(folder); }
  async resources(folder, onPage = () => {}) {
    const items = [], seen = new Set();
    let expected = null;
    for (let pn = 1; pn <= 1000; pn++) {
      const page = await this.page(folder, pn);
      if (expected !== null && expected !== page.count) throw new Error(`收藏夹“${folder.title}”在读取期间发生变化，请重新生成预览。`);
      expected = page.count;
      const before = items.length;
      for (const item of page.items) {
        const key = `${item.id}:${item.type}`;
        if (!seen.has(key)) { seen.add(key); items.push(item); }
      }
      onPage({ folder, page: pn, read: items.length, expected });
      if (!page.more && items.length === expected) return items;
      if (items.length === before || items.length > expected) throw new Error(`收藏夹“${folder.title}”分页重复或读取不完整（${items.length}/${expected}），已停止执行。`);
    }
    throw new Error('分页超过读取上限，已停止执行。');
  }
  async snapshot(folders, onPage) {
    const items = [];
    for (const folder of folders) items.push(...await this.resources(folder, onPage));
    return items;
  }
  async create(title, privacy) {
    const base = { title, privacy: privacy === 'private' ? '1' : '0' };
    const payloads = [base, { ...base, csrf_token: '', platform: 'web', jsonp: 'jsonp' }, { ...base, intro: '', cover: '' }];
    let last;
    for (const form of payloads) {
      try {
        const data = await this.request('folder/add', { form });
        if (!data?.id || !/^\d+$/.test(String(data.id))) throw new ApiError('收藏夹创建返回异常，可能已经创建，请核对后再试。', { ambiguousWrite: true });
        return { id: String(data.id), title };
      } catch (error) {
        last = error;
        // Only explicit rejections known to need alternate form fields may retry.
        if (!error.rejected || ![-112, -400].includes(error.code)) throw error;
      }
    }
    throw last;
  }
  move(operation, targetId) {
    return this.request('resource/move', { form: { src_media_id: operation.sourceId, tar_media_id: targetId,
      resources: operation.items.map(item => `${item.id}:${item.type}`).join(','), platform: 'web' } });
  }
}

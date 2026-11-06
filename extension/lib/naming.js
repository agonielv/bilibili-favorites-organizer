const nameKey = name => String(name).trim().toLowerCase();
function uniqueName(preferred, reserved, marker = '') {
  let suffix = '', index = 2, candidate;
  do {
    candidate = Array.from(preferred).slice(0, 20 - marker.length - suffix.length).join('') + marker + suffix;
    if (!reserved.has(nameKey(candidate))) { reserved.add(nameKey(candidate)); return candidate; }
    suffix = `-${index++}`;
  } while (true);
}

export function planFolderNames(chunks, sources, existingFolders, rules) {
  const reserved = new Set(existingFolders.map(folder => nameKey(folder.title)));
  const inherited = rules.naming === 'inherit' ? sources.slice(0, chunks.length) : [];
  for (const source of inherited) {
    if (!String(source.title || '').trim()) throw new Error('来源收藏夹名称为空，无法继承，请重新读取来源。');
    if (Array.from(source.title).length > 20 || /[\u0000-\u001f]/.test(source.title)) throw new Error('来源收藏夹名称不符合 1–20 个字符的要求，无法原样继承，请改用配置的基础名称。');
    reserved.add(nameKey(source.title));
  }
  const sourceRenames = [];
  if (inherited.length && chunks.length >= sources.length) {
    for (const source of inherited) {
      // Leave room for the requested marker even when the original name is full.
      sourceRenames.push({ id: String(source.id), from: String(source.title), to: uniqueName(String(source.title), reserved, '旧') });
    }
  }
  let renamedTargets = 0;
  const targets = chunks.map((items, index) => {
    if (inherited[index]) return { name: String(inherited[index].title), inheritedFrom: String(inherited[index].id), items };
    const requested = rules.base + (chunks.length > 1 ? `-${index + 1}` : '');
    const name = uniqueName(requested, reserved);
    if (name !== requested) renamedTargets++;
    return { name, items };
  });
  return { chunks: targets, sourceRenames, renamedTargets };
}

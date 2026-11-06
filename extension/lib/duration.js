export function formatDuration(value) {
  const numeric = Number(value), seconds = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分 ${remainder} 秒`;
  if (minutes) return `${minutes} 分 ${remainder} 秒`;
  return `${remainder} 秒`;
}

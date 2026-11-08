export function currentImageSlots(jobs, rowId) {
  const slots = new Map();
  for (const job of jobs) {
    if (job.kind !== 'image' || (rowId !== undefined && job.rowId !== rowId) || job.archivedAt || job.discardedAt) continue;
    const key = `${job.rowId}:${job.slot}`;
    const prior = slots.get(key);
    if (!prior || job.status === 'succeeded' || (prior.status !== 'succeeded' && job.attempt >= prior.attempt)) slots.set(key, job);
  }
  return [...slots.values()].sort((a, b) => a.slot - b.slot);
}

export const imageJobStages = {
  'local-input': '本地参考图或任务参数',
  credentials: '读取生图连接和密钥',
  'model-request': '调用生图服务',
  'local-save': '接收图片后保存到本机',
};

export function imageJobError(job) {
  return job.error?.trim() || (job.status === 'failed' || job.status === 'unknown'
    ? '这条任务没有记录具体原因，可查看任务详情中的模型和时间。' : '');
}

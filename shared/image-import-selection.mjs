import { imageBatchCodeKey } from './image-batch-import.mjs';

function nextSuffix(code, occupied) {
  const base = code.replace(/[.。．]$/, '').replace(/_\d+$/, '');
  for (let number = 2; ; number++) {
    const suffix = `_${number}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!occupied.has(imageBatchCodeKey(candidate))) return candidate;
  }
}

export function planImageImport(rows, targets = [], choices = {}) {
  const reserved = new Set(targets.map(row => imageBatchCodeKey(row.code)));
  for (const row of rows) {
    if (!row.errors.length) reserved.add(imageBatchCodeKey(row.values.code));
  }
  const incomingCodes = new Set(), incomingFolders = new Set(), replaced = new Set();
  return rows.map((row, index) => {
    if (row.errors.length) return { index, action: 'skip', options: [] };
    const { code, count } = row.values;
    const key = imageBatchCodeKey(code);
    const codeOwners = targets.filter(target => imageBatchCodeKey(target.code) === key);
    const folderOwners = row.folderKey ? targets.filter(target => target.folderKey === row.folderKey) : [];
    const owners = [...new Set([...codeOwners, ...folderOwners])];
    const target = owners.length === 1 ? owners[0] : null;
    const sameFolder = Boolean(folderOwners.length || (row.folderKey && incomingFolders.has(row.folderKey)));
    const sameCode = Boolean(codeOwners.length || incomingCodes.has(key));
    const conflict = sameFolder || sameCode;
    const overwrite = target && !replaced.has(target.id) && !target.busy && count >= target.minimumCount &&
      !targets.some(other => other.id !== target.id && imageBatchCodeKey(other.code) === imageBatchCodeKey(target.code)) &&
      !incomingCodes.has(key) && !incomingCodes.has(imageBatchCodeKey(target.code)) &&
      !(row.folderKey && incomingFolders.has(row.folderKey));
    const options = [];
    if (!sameFolder) options.push(sameCode ? 'rename' : 'add');
    if (conflict && overwrite) options.push('overwrite');
    const choice = choices[index];
    const preferred = choice === 'add' || choice === 'rename' ? options.find(option => option !== 'overwrite') :
      choice ?? (sameFolder ? 'skip' : options[0]);
    const action = options.includes(preferred) ? preferred : 'skip';
    const finalCode = action === 'rename' ? nextSuffix(code, reserved) : action === 'overwrite' ? target.code : code;
    if (action !== 'skip') {
      incomingCodes.add(imageBatchCodeKey(finalCode));
      reserved.add(imageBatchCodeKey(finalCode));
      if (row.folderKey) incomingFolders.add(row.folderKey);
      if (action === 'overwrite') replaced.add(target.id);
    }
    return { index, action, options, finalCode, conflict, target, sameFolder, preferred };
  });
}

export function selectImageImportEntries(plan, requests) {
  if (!plan || plan.errors.length || !Array.isArray(requests) || !requests.length || requests.length > plan.rows.length) {
    throw new Error('请选择要导入的有效任务行。');
  }
  const choices = Object.fromEntries(plan.rows.map((_, index) => [index, 'skip']));
  for (const request of requests) {
    const { index, action } = request || {};
    if (!Number.isInteger(index) || index < 0 || index >= plan.rows.length || choices[index] !== 'skip' ||
        !['add', 'rename', 'overwrite'].includes(action)) throw new Error('导入选择无效，请重新预览。');
    choices[index] = action;
  }
  const entries = [];
  for (const decision of planImageImport(plan.rows, plan.targets, choices)) {
    if (choices[decision.index] === 'skip') continue;
    if (decision.action !== choices[decision.index]) throw new Error('所选行的编号或目录冲突尚未处理，请重新预览。');
    const row = plan.rows[decision.index];
    entries.push({
      ...row,
      values: { ...row.values, code: decision.finalCode },
      ...(decision.action === 'overwrite' ? { overwriteId: decision.target.id, overwriteRevision: decision.target.revision } : {}),
    });
  }
  return entries;
}

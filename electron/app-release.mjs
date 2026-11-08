const repository = '123225073/ziyun-image-studio';
export const releasePage = `https://github.com/${repository}/releases/latest`;

function versionParts(value) {
  return /^(?:v)?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(value))?.slice(1).map(Number);
}

export async function checkAppRelease(version, fetchRelease, fetchPage = fetchRelease) {
  const current = versionParts(version);
  if (!current) throw new Error('当前版本号无法比较，请查看发布页。');
  const options = { credentials: 'omit', signal: AbortSignal.timeout(8000) };
  let latest;
  try {
    const response = await fetchRelease(`https://api.github.com/repos/${repository}/releases/latest`, {
      ...options, headers: { Accept: 'application/vnd.github+json' }, redirect: 'error',
    });
    if (response.ok) {
      const release = await response.json();
      if (!release.draft && !release.prerelease) latest = versionParts(release.tag_name);
    }
  } catch { /* The public release page can still be available. */ }
  if (!latest) {
    try {
      const response = await fetchPage(releasePage, { ...options, redirect: 'manual' });
      const tagPrefix = `https://github.com/${repository}/releases/tag/`;
      const location = response.headers.get('location') || '';
      if (response.status === 302 && location.startsWith(tagPrefix)) latest = versionParts(location.slice(tagPrefix.length));
      await response.body?.cancel().catch(()=>{});
    } catch { /* Report failure if neither source provided a stable version. */ }
  }
  if (!latest) throw new Error('暂时无法查询 GitHub 最新版，请稍后重试或打开发布页。');
  const difference = latest.map((part, index) => part - current[index]).find(Boolean) || 0;
  return { latest: latest.join('.'), comparison: difference > 0 ? 'update' : difference < 0 ? 'ahead' : 'current' };
}

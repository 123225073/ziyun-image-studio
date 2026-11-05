import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Every model response and every persisted file in this check is local and isolated.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'test-output', `montage-review-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(fixture, 'data');
await fs.mkdir(fixture, { recursive: true });
const requests = [], errors = [];
let malformedFirstReview = true;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find(message => message.role === 'system')?.content || '';
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    let output, kind;
    if (system.includes('candidateIndexes')) {
      kind = 'rematch';
      const rainy = input.current.segments[0].text.includes('下雨');
      output = { candidateIndexes: [rainy ? 2 : 1, rainy ? 2 : 1], reason: '保留开场天气，改选与之衔接的提醒。请人工复核。' };
    } else if (system.includes('修正后的该段全文')) {
      kind = 'rewrite';
      output = { segments: input.current.segments.map((segment, index) => ({ ...segment, text: index ? `因此，${segment.text}` : segment.text })), reason: '只在后段补充连接词，保留原信息。请人工复核。' };
    } else {
      kind = 'review';
      const rainy = input.segments[0].text.includes('下雨');
      const umbrella = input.segments[1].text.includes('雨伞');
      output = rainy === umbrella
        ? { status: 'pass', summary: '本地验收：段落衔接一致。', issues: [] }
        : { status: 'issue', summary: '本地验收：天气与行动提醒需要重新衔接。', issues: [{ section: 'B', quote: input.segments[1].text, message: '开场天气和后段提醒不一致。', suggestion: '重新选择对应天气的提醒，或补充过渡说明。' }] };
    }
    requests.push({ kind, input });
    const content = kind === 'review' && malformedFirstReview ? '本地故障样例：暂时未返回结构化结果' : JSON.stringify(output);
    if (kind === 'review') malformedFirstReview = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  } catch (error) {
    errors.push(`mock: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const call = (method, ...args) => page.evaluate(({ method, args }) => window.studio.call(method, ...args), { method, args });
const waitState = async (predicate, timeout = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await call('getState');
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('等待隔离校对状态超时');
};
async function launch() {
  application = await electron.launch({ executablePath: process.env.ZIYUN_TEST_EXE || createRequire(import.meta.url)('electron'), args: process.env.ZIYUN_TEST_EXE ? [] : [root], env, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('add-row').waitFor();
  await page.setViewportSize({ width: 1513, height: 1035 });
  await page.getByRole('button', { name: '03 混剪成片', exact: true }).click();
}
async function close() {
  if (!application) return;
  try { await application.evaluate(({ app }) => app.exit(0)); } catch {}
  await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
  application = null;
}
const reviewPanel = () => page.getByRole('region', { name: 'AI 文案逻辑校对', exact: true });
const button = name => reviewPanel().getByRole('button', { name, exact: true });
const idle = () => reviewPanel().locator('.review-progress').waitFor({ state: 'hidden' });
const sessionItems = state => Object.values(state.montageReviews?.[0]?.items || {});
const fillCandidates = async (section, values) => {
  const editor = page.getByTestId(`candidates-${section}`);
  for (let index = 0; index < values.length; index++) {
    await editor.getByRole('button', { name: index ? '新增文案' : '添加第一条候选文案', exact: true }).click();
    await page.getByLabel(`${section} 段候选文案 ${index + 1}`, { exact: true }).fill(values[index]);
  }
};
const candidateCopy = state => state.montageSetup.sections.map(section => section.candidates);
const accept = async (count, cancelFirst = false) => {
  await button(`检查并采纳建议（${count}）`).click();
  const dialog = page.getByRole('dialog', { name: '采纳文案建议', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.review-compare').count(), count);
  if (cancelFirst) { await dialog.getByRole('button', { name: '返回检查', exact: true }).click(); return; }
  await dialog.getByRole('button', { name: `确认采纳 ${count} 条`, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await idle();
};
try {
  await launch();
  await call('saveProvider', { id: 'local-review', name: '本地验收语言模型', protocol: 'openai-chat', baseUrl, model: 'fixture-model', key: 'isolated-fixture-key' });
  await call('updateSettings', { bindings: { rewrite: 'local-review' }, autoExport: false });
  const originals = [['今天天气很好。\n可以看看窗外的阳光。', '今天下雨了。'], ['可以出门散步。', '记得带上雨伞。']];
  await fillCandidates('A', originals[0]); await fillCandidates('B', originals[1]);
  assert.match(await page.getByTestId('combination-count').innerText(), /2 × 2 = 4/);
  assert.equal(await page.getByTestId('candidates-A').locator('.candidate-entry').count(), 2, '内部换行不增加候选条数');
  await waitState(state => JSON.stringify(candidateCopy(state)) === JSON.stringify(originals));
  await reviewPanel().getByLabel('文案校对AI连接', { exact: true }).selectOption('local-review');
  await button('开始 AI 校对').click();
  await waitState(state => sessionItems(state).length === 4 && sessionItems(state).every(item => ['error', 'pass', 'issue'].includes(item.status)));
  await idle();
  assert.equal(requests.length, 4, '全部组合逐条调用本地模型');
  assert.match(await reviewPanel().locator('.review-notice[role=status]').innerText(), /完成 3 条，1 条未完成/);
  assert.equal(await reviewPanel().locator('.review-item').count(), 2, '有问题筛选只显示两条问题组合');
  assert(requests.every(item => item.input.masterText === item.input.segments.map(segment => segment.text).join('\n')), '校对完整文案而非各段单独校对');

  await button('待复检 / 失败').click();
  assert.equal(await reviewPanel().locator('.review-item.error').count(), 1);
  await button('重新校对').click(); await idle();
  await waitState(state => sessionItems(state).filter(item => item.status === 'pass').length === 2);
  assert.equal(requests.length, 5);
  await button('有问题').click();
  await button('选择全部问题').click();
  await button('重新搭配所选').click();
  await waitState(state => sessionItems(state).filter(item => item.proposal?.mode === 'rematch').length === 2); await idle();
  let state = await call('getState');
  assert.equal(sessionItems(state).filter(item => item.accepted).length, 0, '建议未采纳前不改变实际组合');
  assert.deepEqual(candidateCopy(state), originals);
  await accept(2, true);
  assert.equal(sessionItems(await call('getState')).filter(item => item.accepted).length, 0, '取消采纳不覆盖文案');
  await reviewPanel().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(fixture, 'rematch-proposals.png') });
  await accept(2);
  state = await waitState(state => sessionItems(state).filter(item => item.accepted && item.status === 'unchecked').length === 2);
  const rematched = sessionItems(state).filter(item => item.accepted).map(item => ({ index: item.index, text: item.accepted.masterText }));
  assert.deepEqual(candidateCopy(state), originals, '采纳只改变完整组合，原候选保留');
  for (const item of rematched) assert.equal(await page.locator('.batch-copy-preview>div').nth(item.index).locator('p').innerText(), item.text);

  await button('开始 AI 校对').click(); await idle();
  state = await waitState(state => sessionItems(state).every(item => item.status === 'pass'));
  assert.equal(requests.filter(item => item.kind === 'review').length, 7, '原已通过两条复用结果，新采纳两条重新校对');
  await button('已通过').click();
  for (const item of rematched) await reviewPanel().getByLabel(`选择文案组合 ${item.index + 1}`, { exact: true }).check();
  await button('轻度改写所选').click();
  await waitState(state => sessionItems(state).filter(item => item.proposal?.mode === 'rewrite').length === 2); await idle();
  state = await call('getState');
  for (const item of rematched) assert.equal(state.montageReviews[0].items[item.index].accepted.masterText, item.text, '改写建议不能自动覆盖已采纳文案');
  await accept(2);
  state = await waitState(state => sessionItems(state).filter(item => item.accepted?.mode === 'rewrite' && item.status === 'unchecked').length === 2);
  const accepted = sessionItems(state).filter(item => item.accepted).map(item => ({ index: item.index, text: item.accepted.masterText, proposalId: item.accepted.proposalId }));
  assert(accepted.every(item => item.text.includes('因此，')));
  assert.deepEqual(candidateCopy(state), originals);
  await button('开始 AI 校对').click(); await idle();
  await waitState(state => sessionItems(state).every(item => item.status === 'pass'));
  await button('已通过').click();
  const beforeRecheck = requests.length;
  await button('重新校对').first().click(); await idle();
  assert.equal(requests.length, beforeRecheck + 1, '明确重新校对必须发起新调用');
  assert(requests.filter(item => item.kind === 'review').some(item => item.input.masterText.includes('因此，')), '复检读取用户已采纳的全文');

  await close(); await launch();
  const restored = await call('getState');
  assert.deepEqual(candidateCopy(restored), originals);
  for (const item of accepted) {
    const record = restored.montageReviews[0].items[item.index];
    assert.equal(record.accepted.masterText, item.text); assert.equal(record.accepted.proposalId, item.proposalId); assert.equal(record.status, 'pass');
    assert.equal(await page.locator('.batch-copy-preview>div').nth(item.index).locator('p').innerText(), item.text);
  }
  await button('已通过').click(); assert.equal(await reviewPanel().locator('.review-item.pass').count(), 4);
  await page.setViewportSize({ width: 1050, height: 800 });
  await reviewPanel().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(fixture, 'restored-review-narrow.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, modelCalls: requests.length, reviewCalls: requests.filter(item => item.kind === 'review').length, rematchCalls: requests.filter(item => item.kind === 'rematch').length, rewriteCalls: requests.filter(item => item.kind === 'rewrite').length, accepted, errors }, null, 2));
  console.log(`MONTAGE_REVIEW_UI_PASS ${fixture}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

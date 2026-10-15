import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extractor } from '../src/api/extractor';
import { inlineScreenshot } from '../src/api/screenshot-input';
import { newDraft } from '../src/core/drafts';
import { emptyState } from '../src/core/types';
import { apiEntry, config, TODAY } from './fixtures';

const settings = { baseUrl: 'https://example.test', model: 'synthetic-model', secretId: 'test' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=', 'base64');
const previousDate = '2026-10-11';
function reply(mode: 'text' | 'screenshots') {
  const entry = apiEntry({ date: previousDate, received_amount: null, received_amount_quote: null });
  return mode === 'text'
    ? { version: 3, entries: [entry], excluded: [], complete_dates: [] }
    : { version: 1, images: [{ image_index: 1, text: '早餐八块', entries: [entry], excluded: [] }] };
}
function run(extractor: Extractor, mode: 'text' | 'screenshots', model = settings.model) {
  const draft = newDraft('昨天早餐八块', TODAY);
  return mode === 'text'
    ? extractor.extract({ ...settings, model }, 'synthetic-key', draft, config(), emptyState())
    : extractor.extractScreenshots({ ...settings, model }, 'synthetic-key', draft, config(), emptyState(), [inlineScreenshot('synthetic-image', png, 'activity')], { date: previousDate, onlySelectedDate: true, onlyExpenses: true });
}

for (const mode of ['text', 'screenshots'] as const) {
  test(`${mode}：输出额度耗尽须说明截断原因，不能只报未完整结束`, async () => {
    const draft = newDraft('昨天早餐八块', TODAY), before = structuredClone(draft), state = emptyState();
    const extractor = new Extractor(async () => ({ status: 200, json: {
      choices: [{ finish_reason: 'length', message: { content: '{', reasoning_content: 'synthetic reasoning' } }],
      usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8180 } }
    } }));
    const run = () => mode === 'text'
      ? extractor.extract(settings, 'synthetic-key', draft, config(), state)
      : extractor.extractScreenshots(settings, 'synthetic-key', draft, config(), state, [inlineScreenshot('synthetic-image', png, 'activity')], { date: TODAY, onlySelectedDate: true, onlyExpenses: true });
    await assert.rejects(run, error => {
      assert.match((error as Error).message, /输出.*(?:上限|额度)|截断/);
      assert.match((error as Error).message, /length/);
      assert.match((error as Error).message, /8192/);
      assert.match((error as Error).message, /思考.*8180/);
      assert.equal((error as Error).message.includes('关闭深度思考'), false);
      assert.equal((error as Error).message.includes('synthetic reasoning'), false);
      return true;
    });
    assert.deepEqual(draft, before);
    assert.equal(state.transactions.size, 0);
  });

  test(`${mode}：Flash保持深度思考并解析独立JSON结果，始终只请求配置的模型`, async () => {
    const requests: Record<string, unknown>[] = [];
    const extractor = new Extractor(async (_url, body) => {
      const request = body as Record<string, unknown>; requests.push(request);
      return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { reasoning_content: 'synthetic private reasoning; never store this', content: JSON.stringify(reply(mode)) } }] } };
    });
    const result = await run(extractor, mode, 'deepseek-flash');
    assert.equal(result.rows[0].date, previousDate);
    assert.equal(result.rows[0].amount, '8.00');
    assert.equal(result.rows[0].reviewed, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'deepseek-flash');
    assert.deepEqual(requests[0].thinking, { type: 'enabled' });
    assert.equal(requests[0].max_tokens, 65536);
    assert.equal(JSON.stringify(result).includes('synthetic private reasoning'), false);
    const messages = requests[0].messages as { content: unknown }[];
    const input = mode === 'text' ? JSON.parse(messages[1].content as string) : JSON.parse((messages[1].content as { text: string }[])[0].text);
    assert.equal(input.context.today, TODAY);
    if (mode === 'screenshots') assert.equal(input.date, previousDate);
  });

  test(`${mode}：截断后不自动重试、不切换Pro、不接收看似完整的局部JSON`, async () => {
    const models: unknown[] = [];
    const extractor = new Extractor(async (_url, body) => {
      models.push((body as { model: string }).model);
      return { status: 200, json: { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(reply(mode)) } }] } };
    });
    await assert.rejects(() => run(extractor, mode, 'deepseek-flash'), /未完整|截断/);
    assert.deepEqual(models, ['deepseek-flash']);
  });

  test(`${mode}：拦截、工具回复和缺失结束标记不得当作账单`, async () => {
    for (const reason of ['content_filter', 'tool_calls', undefined]) {
      const extractor = new Extractor(async () => ({ status: 200, json: { choices: [{ finish_reason: reason, message: { content: JSON.stringify(reply(mode)) } }] } }));
      await assert.rejects(() => run(extractor, mode), reason === 'content_filter' ? /拦截/ : reason === 'tool_calls' ? /工具/ : /结束标记/);
    }
  });

  test(`${mode}：仅思考内容与服务端中断须明确提示，推理正文不进入错误`, async () => {
    for (const reason of ['stop', 'aborted']) {
      const extractor = new Extractor(async () => ({ status: 200, json: {
        choices: [{ finish_reason: reason, message: { content: null, reasoning_content: 'synthetic private reasoning' } }],
        usage: { completion_tokens: 9200, completion_tokens_details: { reasoning_tokens: 9200 } }
      } }));
      await assert.rejects(() => run(extractor, mode), error => {
        assert.match((error as Error).message, reason === 'stop' ? /只返回了思考内容/ : /aborted/);
        assert.match((error as Error).message, /思考 9200/);
        assert.equal((error as Error).message.includes('synthetic private reasoning'), false);
        return true;
      });
    }
  });
}

test('其他兼容模型不附加DeepSeek专用参数', async () => {
  const extractor = new Extractor(async (_url, body) => {
    assert.equal(Object.hasOwn(body!, 'thinking'), false);
    assert.equal((body as { model: string }).model, settings.model);
    assert.equal((body as { max_tokens: number }).max_tokens, 8192);
    return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply('text')) } }] } };
  });
  await run(extractor, 'text');
});

test('Flash开启思考可等待超过120秒，300秒超时只发一次请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const delayed = new Extractor(async () => {
    count++; await new Promise(resolve => setTimeout(resolve, 180000));
    return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply('text')) } }] } };
  });
  const completed = run(delayed, 'text', 'deepseek-flash');
  t.mock.timers.tick(180000);
  assert.equal((await completed).rows.length, 1);
  const hung = new Extractor(async () => { count++; return new Promise(() => {}); });
  const failed = assert.rejects(() => run(hung, 'text', 'deepseek-flash'), /300 秒/);
  t.mock.timers.tick(300000);
  await failed;
  assert.equal(count, 2);
});

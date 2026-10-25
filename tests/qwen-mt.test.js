import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ContextLengthError, TranslationError, translateCues } from '../src/background/translator.js';

const settings = {
  apiBaseUrl: 'https://translation.example/compatible-mode/v1',
  model: 'qwen-mt-flash',
  targetLanguage: 'zh-CN',
};
const cues = [{ id: 'source-09', text: '  Hello\nworld  ', start: 12, end: 14 }];
const completion = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
  headers: { 'Content-Type': 'application/json' },
});

test('Qwen-MT sends only the original user text and top-level translation options, retaining the source ID', async () => {
  let request;
  const result = await translateCues(settings, cues, {
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return completion('  你好\n世界  ');
    },
  });
  assert.equal(request.url, 'https://translation.example/compatible-mode/v1/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), {
    model: 'qwen-mt-flash',
    stream: false,
    messages: [{ role: 'user', content: cues[0].text }],
    translation_options: { source_lang: 'auto', target_lang: 'Chinese' },
  });
  assert.deepEqual(result, [{ id: 'source-09', text: '你好\n世界' }]);
});

test('Qwen-MT maps configured language aliases to official names while preserving supported names and other codes', async () => {
  // Official language table: Chinese (zh), Traditional Chinese (zh_tw).
  for (const [targetLanguage, target] of [
    ['zh-CN', 'Chinese'], ['zh', 'Chinese'], ['zh-TW', 'Traditional Chinese'], ['zh_tw', 'Traditional Chinese'],
    ['en', 'English'], ['ja', 'Japanese'], ['ko', 'Korean'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
    ['English', 'English'], ['Traditional Chinese', 'Traditional Chinese'], ['sw', 'sw'],
  ]) {
    let sent;
    await translateCues({ ...settings, targetLanguage, sourceLanguage: 'ja' }, cues, {
      fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return completion('translation'); },
    });
    assert.deepEqual(sent.translation_options, { source_lang: 'auto', target_lang: target }, targetLanguage);
  }
});

test('Qwen-MT translates cues sequentially and publishes each validated row before the next request', async () => {
  const source = [cues[0], { id: '003', text: 'Next' }, { id: 'last-id', text: 'Last' }];
  const events = [];
  let active = 0, maxActive = 0;
  const result = await translateCues(settings, source, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const cue = source.find(item => item.text === body.messages[0].content);
      events.push(['fetch', cue?.id]);
      active++;
      maxActive = Math.max(maxActive, active);
      await nextTurn();
      active--;
      return completion(`译:${cue?.text}`);
    },
    onPartial: rows => events.push(['partial', structuredClone(rows)]),
  });
  const expected = source.map(cue => ({ id: cue.id, text: `译:${cue.text}`.trim() }));
  assert.deepEqual(result, expected);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, source.flatMap((cue, index) => [
    ['fetch', cue.id], ['partial', [expected[index]]],
  ]));
});

test('each actual MT request checks permission and synchronously records its own source cue before dispatch', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }];
  const events = [];
  const result = await translateCues(settings, source, {
    canRequest: part => { events.push(['canRequest', part.map(cue => cue.id)]); return true; },
    onRequest: part => events.push(['onRequest', part.map(cue => cue.id)]),
    fetchImpl: async (_url, options) => {
      events.push(['fetch', JSON.parse(options.body).messages[0].content]);
      return completion('译文');
    },
  });
  assert.equal(result.length, source.length);
  assert.deepEqual(events, source.flatMap(cue => [
    ['canRequest', [cue.id]], ['onRequest', [cue.id]], ['fetch', cue.text],
  ]));
});

test('suspension between MT cues keeps published results but never dispatches or counts later requests', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }, { id: 'last', text: 'Last' }];
  let allowed = true;
  const checked = [], requested = [], published = [];
  let calls = 0;
  await assert.rejects(translateCues(settings, source, {
    canRequest: part => { checked.push(part.map(cue => cue.id)); return allowed; },
    onRequest: part => requested.push(part.map(cue => cue.id)),
    onPartial: rows => { published.push(...rows); allowed = false; },
    fetchImpl: async () => { calls++; return completion('已译'); },
  }), error => error instanceof TranslationError && error.category === 'suspend');
  assert.equal(calls, 1);
  assert.deepEqual(checked, [['source-09'], ['next']]);
  assert.deepEqual(requested, [['source-09']]);
  assert.deepEqual(published, [{ id: 'source-09', text: '已译' }]);
});

test('a single MT cue publishes its validated translation as well as returning it', async () => {
  const partials = [];
  const result = await translateCues(settings, cues, {
    fetchImpl: async () => completion('单条译文'),
    onPartial: rows => partials.push(structuredClone(rows)),
  });
  assert.deepEqual(partials, [[{ id: 'source-09', text: '单条译文' }]]);
  assert.deepEqual(result, partials[0]);
});

test('MT model families and dated versions use the raw-text protocol', async () => {
  for (const model of ['qwen-mt-flash', 'qwen-mt-plus', 'qwen-mt-lite', 'qwen-mt-turbo', 'qwen-mt-flash-2025-12-15', 'qwen-mt-turbo-2025-02-11']) {
    let body;
    await translateCues({ ...settings, model }, cues, {
      fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return completion('译文'); },
    });
    assert.equal(body.model, model);
    assert.deepEqual(body.messages, [{ role: 'user', content: cues[0].text }]);
    assert.deepEqual(body.translation_options, { source_lang: 'auto', target_lang: 'Chinese' });
  }
});

test('other models retain one JSON subtitle request, with one gate/start callback and no partial callback', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }];
  const expected = source.map(cue => ({ id: cue.id, text: `译:${cue.id}` }));
  for (const model of ['qwen-plus', 'qwen-turbo', 'qwen3-max', 'qwen3-mt-flash', 'not-qwen-mt-flash', 'qwen-mtflash', 'vendor/qwen-mt-flash']) {
    const events = [];
    let body;
    const result = await translateCues({ ...settings, model }, source, {
      canRequest: part => { events.push(['canRequest', part]); return true; },
      onRequest: part => events.push(['onRequest', part]),
      onPartial: () => assert.fail('chat JSON must not publish partial rows'),
      fetchImpl: async (_url, options) => {
        events.push(['fetch']);
        body = JSON.parse(options.body);
        return completion(JSON.stringify({ translations: [...expected].reverse() }));
      },
    });
    assert.deepEqual(result, expected);
    assert.deepEqual(events, [['canRequest', source], ['onRequest', source], ['fetch']]);
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream']);
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /zh-CN/);
    assert.equal(body.messages[1].role, 'user');
    assert.deepEqual(JSON.parse(body.messages[1].content), { subtitles: source.map(({ id, text }) => ({ id, text })) });
  }
});

test('a false initial gate suspends MT and chat without counting or sending any request', async () => {
  for (const model of ['qwen-mt-flash', 'qwen-plus']) {
    let checks = 0;
    await assert.rejects(translateCues({ ...settings, model }, cues, {
      canRequest: part => { checks++; assert.deepEqual(part, cues); return false; },
      onRequest: () => assert.fail('suspended request must not be counted'),
      onPartial: () => assert.fail('suspended request has no translation'),
      fetchImpl: () => assert.fail('suspended request must not be sent'),
    }), error => error instanceof TranslationError && error.category === 'suspend');
    assert.equal(checks, 1);
  }
});

test('MT validation rejects empty, missing, non-string and oversized content without publishing or exposing it', async () => {
  for (const content of ['', '  \n ', null, undefined, [{ text: 'provider-secret' }], { text: 'provider-secret' }, `provider-secret${'x'.repeat(40_000)}`]) {
    await assert.rejects(translateCues(settings, cues, {
      fetchImpl: async () => completion(content),
      onPartial: () => assert.fail('invalid content must never be published'),
    }), error => error instanceof TranslationError && error.category === 'validation'
      && !/provider-secret/.test(error.message) && !/provider-secret/.test(JSON.stringify(error)));
  }
});

test('an invalid later MT reply preserves earlier published rows and stops subsequent requests', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }, { id: 'last', text: 'Last' }];
  const published = [];
  let calls = 0;
  await assert.rejects(translateCues(settings, source, {
    fetchImpl: async () => completion(++calls === 1 ? '已完成' : ''),
    onPartial: rows => published.push(...rows),
  }), error => error.category === 'validation');
  assert.equal(calls, 2);
  assert.deepEqual(published, [{ id: 'source-09', text: '已完成' }]);
});

test('MT HTTP and transport failures retain shared safe classifications and retry hints', async () => {
  for (const [status, category] of [[400, 'config'], [401, 'config'], [403, 'config'], [404, 'config'], [408, 'timeout'], [422, 'config'], [429, 'rate-limit'], [500, 'server'], [503, 'server']]) {
    await assert.rejects(translateCues(settings, cues, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'provider-secret' } }), {
        status, headers: { 'Retry-After': '3' },
      }),
    }), error => error instanceof TranslationError && error.category === category
      && error.status === status && error.retryAfterMs === 3000
      && !/provider-secret/.test(error.message) && !/provider-secret/.test(JSON.stringify(error)));
  }
  await assert.rejects(translateCues(settings, cues, {
    fetchImpl: async () => { throw new Error('transport-secret'); },
  }), error => error.category === 'network' && !/transport-secret/.test(error.message) && !('cause' in error));
  await assert.rejects(translateCues(settings, cues, {
    fetchImpl: async () => new Response('provider-secret'),
  }), error => error.category === 'validation' && !/provider-secret/.test(error.message));
});

test('MT explicit length errors never publish a truncated or rejected translation', async () => {
  for (const failure of [
    () => new Response('provider-secret', { status: 413 }),
    () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'provider-secret' } }), { status: 400 }),
    () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'provider-secret' } }] })),
  ]) {
    let calls = 0;
    await assert.rejects(translateCues(settings, cues, {
      fetchImpl: async () => { calls++; return failure(); },
      onPartial: () => assert.fail('incomplete translation must not be published'),
    }), error => error instanceof ContextLengthError && error.category === 'length' && !/provider-secret/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('MT timeout releases a stalled fetch or response body without dispatching following cues', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }];
  for (const stalled of [
    () => new Promise(() => {}),
    async () => ({ ok: true, json: () => new Promise(() => {}) }),
  ]) {
    let calls = 0, started = 0;
    await assert.rejects(translateCues(settings, source, {
      timeoutMs: 15,
      onRequest: () => { started++; },
      onPartial: () => assert.fail('timed-out request must not publish rows'),
      fetchImpl: (...args) => { calls++; return stalled(...args); },
    }), error => error.category === 'timeout');
    assert.equal(calls, 1);
    assert.equal(started, 1);
  }
});

test('MT cancellation releases a stalled fetch or body and never dispatches following cues', async () => {
  const source = [cues[0], { id: 'next', text: 'Next' }];
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController();
    let calls = 0, requestSignal;
    const pending = translateCues(settings, source, {
      signal: controller.signal,
      onPartial: () => assert.fail('cancelled request must not publish rows'),
      fetchImpl: async (_url, options) => {
        calls++;
        requestSignal = options.signal;
        if (stage === 'fetch') return new Promise(() => {});
        return { ok: true, json: () => new Promise(() => {}) };
      },
    });
    await nextTurn();
    controller.abort();
    await assert.rejects(pending, error => error.category === 'cancel');
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 1);
  }
});

test('cancellation between MT cues preserves the published cue without starting another request', async () => {
  const controller = new AbortController();
  const published = [];
  let calls = 0;
  await assert.rejects(translateCues(settings, [cues[0], { id: 'next', text: 'Next' }], {
    signal: controller.signal,
    fetchImpl: async () => { calls++; return completion('已译'); },
    onPartial: rows => { published.push(...rows); controller.abort(); },
  }), error => error.category === 'cancel');
  assert.equal(calls, 1);
  assert.deepEqual(published, [{ id: 'source-09', text: '已译' }]);
});

test('already cancelled MT work never checks, counts or sends an HTTP request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(translateCues(settings, cues, {
    signal: controller.signal,
    canRequest: () => assert.fail('cancelled work must not check demand'),
    onRequest: () => assert.fail('cancelled work must not be counted'),
    fetchImpl: () => assert.fail('cancelled work must not be sent'),
  }), error => error.category === 'cancel');
});

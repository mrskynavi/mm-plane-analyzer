const test = require('node:test');
const assert = require('node:assert');
const FQ = require('../web/core/frage.js');

test('Modelle, Standard und Kosten', () => {
  assert.strictEqual(FQ.DEFAULT_MODEL, 'claude-sonnet-5-5');
  assert.deepStrictEqual(FQ.MODELS.map(m => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.strictEqual(FQ.modelOf('gibt-es-nicht').id, 'claude-sonnet-5-5');
  // Sonnet 5.5: 2 $ / 10 $ pro Million Token
  assert.ok(Math.abs(FQ.costUSD('claude-sonnet-5-5', 1e6, 1e5) - 3) < 1e-9);
  const e = FQ.estimate('claude-haiku-5-5', [{ role: 'user', content: 'x'.repeat(3000) }]);
  assert.ok(e.inTok > 1000 && e.usd > 0 && e.usd < 0.01);
});

test('Anfrage an die Messages API', () => {
  const msgs = FQ.buildMessages([], 'Warum?', { kind: 'field', label: 'Fluggewicht', value: '2450', unit: 'g' }, { a: 1 });
  assert.strictEqual(msgs.length, 1);
  assert.match(msgs[0].content, /Fluggewicht: 2450 g/);
  assert.match(msgs[0].content, /\{"a":1\}/);
  assert.match(msgs[0].content, /Frage: Warum\?$/);
  const b = FQ.requestBody('claude-sonnet-5-5', msgs);
  assert.strictEqual(b.model, 'claude-sonnet-5-5');
  assert.strictEqual(b.stream, true);
  assert.deepStrictEqual(b.thinking, { type: 'adaptive' });
  assert.strictEqual(b.fallbacks, 'default');
  assert.strictEqual(FQ.requestBody('claude-haiku-5-5', msgs).fallbacks, undefined);
  assert.strictEqual(FQ.requestBody('claude-opus-5-5', msgs, false).fallbacks, undefined);
  const h = FQ.requestHeaders('sk-ant-x', 'claude-sonnet-5-5');
  assert.strictEqual(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.strictEqual(h['x-api-key'], 'sk-ant-x');
  assert.ok(h['anthropic-beta']);
  assert.ok(!FQ.requestHeaders('k', 'claude-haiku-5-5')['anthropic-beta']);
  const f = FQ.buildMessages([...msgs, { role: 'assistant', content: 'Darum.' }], 'Und?', {}, {});
  assert.deepStrictEqual(f.slice(-1)[0], { role: 'user', content: 'Und?' });
  assert.match(FQ.SYSTEM, /Du/); assert.match(FQ.SYSTEM, /Schätzungen/);
});

test('Stream lesen, auch über Stückgrenzen', () => {
  const st = FQ.sseState();
  const ev = o => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const all = ev({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1200, output_tokens: 1 } } })
    + ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } })
    + ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hallo ' } })
    + ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Christoph' } })
    + ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 340 } });
  for (let i = 0; i < all.length; i += 17) FQ.sseFeed(st, all.slice(i, i + 17));
  assert.strictEqual(st.text, 'Hallo Christoph');
  assert.strictEqual(st.inTok, 1200); assert.strictEqual(st.outTok, 340); assert.strictEqual(st.stop, 'end_turn');
});

test('Daten verschlanken und Markdown', () => {
  const s = FQ.slim({ coords: [[0, 0]], a: Array.from({ length: 100 }, (_, i) => i), b: 1.234567891, c: [{ x: 1 }] });
  assert.strictEqual(s.coords, undefined);
  assert.match(s.a, /100 Werte/);
  assert.strictEqual(s.b, 1.2346);
  assert.deepStrictEqual(s.c, [{ x: 1 }]);
  const h = FQ.markdown('**EWD** passt.\n\n- eins\n- zwei <b>\n\n1. a');
  assert.strictEqual(h, '<p><b>EWD</b> passt.</p><ul><li>eins</li><li>zwei &lt;b&gt;</li></ul><ol><li>a</li></ol>');
  assert.match(FQ.copyText('Frage?', { kind: 'kpi', label: 'E max', value: '38' }, { m: 1 }), /E max: 38[\s\S]*Frage: Frage\?[\s\S]*```json/);
  assert.match(FQ.errorText(401, ''), /Schlüssel/);
  assert.strictEqual(FQ.contextShort({ kind: 'field', label: 'Fluggewicht', value: '2450', unit: 'g' }), 'Feld · Fluggewicht = 2450 g');
});

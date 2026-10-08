import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { selectRoleText } from '../src/role-card.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const IMAGE = { type: 'image', data: { file: 'fixture-sticker.png', url: 'https://images.invalid/sticker', sub_type: 1 } };
const FACE = { type: 'face', data: { id: '66' } };

async function fixture(run, { kind = 'group', mode = 'reserved2', raw = {}, segments = [IMAGE] } = {}) {
  const id = kind === 'group' ? 456 : 123;
  const key = `${kind}:${id}`;
  const calls = { messages: [], images: [], faces: [] };
  class Bot {
    async getMessage(messageId) {
      calls.messages.push(messageId);
      return {
        ...(kind === 'group' ? { group_id: id } : { user_id: id }),
        sender: { user_id: kind === 'group' ? 789 : id, nickname: 'fixture-sender' },
        message: segments,
        ...raw
      };
    }
    async getImage({ file }) { calls.images.push(file); return { base64: PNG }; }
    async fetchFaceEntity(faceId) { calls.faces.push(faceId); return { url: 'https://images.invalid/face', q_des: 'fixture-face' }; }
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
    async sendGroupMessage() { throw new Error('test must not send QQ messages'); }
    async sendPrivateMessage() { throw new Error('test must not send QQ messages'); }
  }
  const h = await bridgeHarness({
    config: { ackMessage: '', socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } },
    globals: {
      SnowLumaWebSocketClient: Bot,
      selectRoleText,
      safeFetchBuffer: async (url) => {
        assert.equal(url, 'https://images.invalid/face');
        return { buffer: Buffer.from(PNG, 'base64') };
      }
    }
  });
  h.setMode(mode);
  h.socialV2.paused = mode === 'reserved2'; // Store the incoming message without scheduling an AI turn.
  const st = h.getSocialV2State(key);
  const incoming = async (message = [{ type: 'reply', data: { id: '-900' } }, { type: 'text', data: { text: 'look at this' } }]) => {
    await h.handleIncoming(kind, id, {
      self_id: 999, user_id: kind === 'group' ? 789 : id, group_id: kind === 'group' ? id : undefined,
      message_id: '-1000', sender: { nickname: 'fixture-person' }, message
    }, h.cfg);
  };
  let server;
  const images = async (ref = '-1000') => {
    h.socialV2.paused = false;
    server ??= h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(ref)}`,
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken }
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    });
  };
  try { await run({ h, st, calls, incoming, images }); }
  finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

test('quoted stickers enter the wake snapshot and resolve to image bytes through the current message id or seq', () => fixture(async ({ h, st, calls, incoming, images }) => {
  await incoming();
  const message = st.recentMessages[0];
  assert.match(message.text, /\[引用 fixture-sender：\[图片\]\]/);
  assert.equal(message.hasMedia, true);
  assert.equal(message.media[0].quotedMessageId, '-900');
  const snapshot = h.buildWakeSnapshotV2('group:456');
  assert.equal(snapshot.messages[0].media[0].index, 1);
  assert.equal(snapshot.messages[0].media[0].quotedMessageId, '-900');
  assert.equal(snapshot.messages[0].media[0].url, undefined);
  for (const ref of ['-1000', '1']) {
    const result = await images(ref);
    assert.equal(result.status, 200);
    assert.equal(result.data.images[0].mimeType, 'image/png');
    assert.equal(result.data.images[0].data, PNG);
  }
  assert.deepEqual(calls.messages, [-900], 'text, media and self detection share the cached get_msg response');
}));

test('own images keep their order and duplicate reply segments do not duplicate quoted media', () => fixture(async ({ st, incoming, images }) => {
  await incoming([
    { type: 'reply', data: { id: '-900' } }, IMAGE,
    { type: 'reply', data: { id: '-900' } }, { type: 'text', data: { text: 'look' } }
  ]);
  assert.equal(st.recentMessages[0].media.length, 2);
  assert.equal(st.recentMessages[0].media[0].quotedMessageId, undefined);
  assert.equal(st.recentMessages[0].media[1].quotedMessageId, '-900');
  const result = await images();
  assert.equal(result.data.images.length, 2);
}));

test('quoted built-in faces return actual image content', () => fixture(async ({ calls, incoming, images }) => {
  await incoming();
  const result = await images();
  assert.equal(result.data.media[0].kind, 'face');
  assert.equal(result.data.images[0].data, PNG);
  assert.deepEqual(calls.faces, [66]);
}, { segments: [FACE] }));

test('private replies to the bot own sticker retain the quoted image', () => fixture(async ({ st, incoming, images }) => {
  await incoming();
  assert.equal(st.recentMessages[0].quoteTargetIsSelf, true);
  assert.equal((await images()).data.images[0].data, PNG);
}, { kind: 'private', raw: { user_id: 999, sender: { user_id: 999, nickname: 'bot' } } }));

for (const [name, options] of [
  ['another group', { raw: { group_id: 777 } }],
  ['missing group ownership', { raw: { group_id: undefined } }],
  ['another private chat', { kind: 'private', raw: { user_id: 888, sender: { user_id: 888 } } }],
  ['group message in a private chat', { kind: 'private', raw: { group_id: 456 } }]
]) {
  test(`quoted media from ${name} stays unreadable`, () => fixture(async ({ st, calls, incoming, images }) => {
    await incoming();
    assert.equal(st.recentMessages[0].hasMedia, false);
    assert.equal((await images()).data.images.length, 0);
    assert.deepEqual(calls.images, []);
  }, options));
}

test('gen1 chat delivery inlines quoted image bytes and labels their source', () => fixture(async ({ h, calls, incoming }) => {
  await incoming();
  const content = h.calls.prompts[0].content;
  assert.equal(content.find(part => part.type === 'image').data, PNG);
  assert.ok(content.some(part => part.type === 'text' && part.text.includes('来自引用消息 -900')));
  assert.deepEqual(calls.messages, [-900]);
}, { mode: 'chat' }));

test('quoted media still respects the five-image limit', () => fixture(async ({ incoming, images }) => {
  await incoming();
  const result = await images();
  assert.equal(result.data.images.filter(image => image.data).length, 5);
  assert.match(result.data.images[5].text, /超过单条上限/);
}, { segments: Array.from({ length: 6 }, (_, index) => ({ type: 'image', data: { file: `fixture-${index}.png` } })) }));

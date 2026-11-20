'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../AutoReply/interactionPolicy');

const message = content => ({ content });

test('interaction probabilities match settings', () => {
  assert.equal(policy.BONG_TAG_REPLY_CHANCE, 0.3);
  assert.equal(policy.CASUAL_CHAT_REPLY_CHANCE, 0.3);
  assert.equal(policy.NORMAL_CHAT_REPLY_CHANCE, 0.2);
  assert.equal(policy.NORMAL_CHAT_REACT_CHANCE, 0.3);
});

test('normal conversation is eligible', () => {
  assert.equal(policy.isIgnoredAutoMessage(message('Hôm nay mọi người chơi vui không?')), false);
});

test('ignore commands, links, secrets and sensitive content', () => {
  for (const content of [
    'mon!help', '/help', '!ping',
    'xem https://example.com nhé', 'discord.gg/example',
    'password: secret123', 'GEMINI_API_KEY=secret123',
    'DISCORD_TOKEN=secret123', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=secret123',
    'nội dung khiêu dâm',
  ]) {
    assert.equal(policy.isIgnoredAutoMessage(message(content)), true, content);
  }
});

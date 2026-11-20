'use strict';

// Chỉ áp dụng cho phản hồi / reaction tự động, không chặn listener lệnh khác.
const { isBlockedContentQuery } = require('./contentFilter');
const URL = /(?:https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/|\b[a-z0-9-]+\.(?:com|net|org|vn|io|gg|app|dev|me|co)(?:\/|\b))/i;
const SECRET = /(?:\b(?:password|passwd|mat\s*khau|mật\s*khẩu|(?:[a-z][a-z0-9]*_)*(?:api[_ -]?key|private[_ -]?key|secret|token)|otp|ma\s*otp|mã\s*otp)\s*[:=]\s*\S+|\b(?:sk-[\w-]{20,}|AIza[\w-]{20,})\b)/i;
const COMMAND = /^\s*(?:\/|!|\.|mon!|<\/@)/i;

function isIgnoredAutoMessage(message) {
  const value = String(message?.content || '').trim();
  return !value || COMMAND.test(value) || URL.test(value) ||
    SECRET.test(value) || isBlockedContentQuery(value);
}

const BONG_TAG_REPLY_CHANCE = 0.3;
const CASUAL_CHAT_REPLY_CHANCE = 0.3;
const NORMAL_CHAT_REPLY_CHANCE = 0.2;
const NORMAL_CHAT_REACT_CHANCE = 0.3;

module.exports = {
  isIgnoredAutoMessage,
  BONG_TAG_REPLY_CHANCE,
  CASUAL_CHAT_REPLY_CHANCE,
  NORMAL_CHAT_REPLY_CHANCE,
  NORMAL_CHAT_REACT_CHANCE,
};

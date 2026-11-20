'use strict';
// Samples are local and scoped to this one guild/channel; no user-account token.
const OWNER = '1398428399357268068';
const GUILD = '1566691700850688013';
const CHANNEL = '1566698252567318538';
const fs = require('node:fs');
const { isIgnoredAutoMessage, BONG_TAG_REPLY_CHANCE } = require('./interactionPolicy');
const path = require('node:path');
const FILE = path.join(__dirname, '..', 'data', 'owner-style.json');
function inScope(m) { return m.guildId === GUILD && m.channelId === CHANNEL; }
function explicitOwnerTag(m) { return new RegExp(`<@!?${OWNER}>`).test(m.content || ''); }
function clean(s) {
  return String(s || '').replace(/https?:\/\/\S+/g, '[link]')
    .replace(/<@!?\d+>/g, '[người được nhắc]')
    .replace(/AIza[\w-]+|[\w-]{24,}\.[\w-]{6,}\.[\w-]{20,}/g, '[đã ẩn khóa]')
    .slice(0, 700);
}
function makeService({ read, write, generate, forbidden = () => false, ready = () => true }) {
  let state = read() || { enabled: true, samples: [] };
  state.samples = Array.isArray(state.samples) ? state.samples : [];
  let learning = false;
  let epoch = 0;
  let busy = false;
  const cooldown = new Map();
  const persist = () => write(state);
  async function remember(m, cache) {
    if (!inScope(m) || m.author.id !== OWNER || m.author.bot || !m.content?.trim() || m.content.startsWith('mon!')) return;
    if (forbidden(m.content) || /PRIVATE KEY|DISCORD_TOKEN|GEMINI_API_KEY|password\s*[:=]/i.test(m.content)) return;
    const started = epoch;
    const targets = new Set([...m.mentions.users.values()].filter(u => u.id !== OWNER && !u.bot).map(u => u.id));
    // Only attribute tone when an explicit tag or same-channel reply establishes the recipient.
    if (m.reference?.messageId && (!m.reference.channelId || m.reference.channelId === CHANNEL)) {
      const ref = cache?.get(m.reference.messageId) || await m.channel.messages.fetch(m.reference.messageId).catch(() => null);
      if (ref && inScope(ref) && !ref.author.bot && ref.author.id !== OWNER) targets.add(ref.author.id);
    }
    if (started !== epoch) return;
    state.samples = state.samples.filter(x => x.id !== m.id);
    state.samples.push({ id: m.id, time: m.createdTimestamp, text: clean(m.content), targets: [...targets] });
    state.samples.sort((a, b) => a.time - b.time);
    state.samples = state.samples.slice(-300);
  }
  async function learn(channel) {
    if (learning) return false;
    learning = true;
    const started = epoch;
    try {
      const cache = new Map();
      let before;
      // At most 500 recent channel messages per explicit scan. No DMs or other channels.
      for (let page = 0; page < 5; page++) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        for (const m of batch.values()) cache.set(m.id, m);
        before = batch.last().id;
        if (batch.size < 100) break;
      }
      for (const m of cache.values()) { if (started !== epoch) return false; await remember(m, cache); }
      persist();
      return true;
    } finally { learning = false; }
  }
  const reply = (m, content) => m.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  async function handle(m) {
    if (!inScope(m) || m.author.bot || m.webhookId) return false;
    const cmd = m.content.trim().toLowerCase();
    if (m.author.id === OWNER) {
      if (cmd.startsWith('mon!style')) {
        if (cmd === 'mon!style off') { state.enabled = false; persist(); await reply(m, 'Đã tắt trả lời thay và học tin nhắn mới.'); }
        else if (cmd === 'mon!style on') { state.enabled = true; persist(); await reply(m, 'Đã bật trả lời thay trong kênh này.'); }
        else if (cmd === 'mon!style clear') { epoch++; state = { enabled: false, samples: [] }; persist(); await reply(m, 'Đã xóa mẫu phong cách và tắt học/trả lời thay.'); }
        else if (cmd === 'mon!style learn') {
          if (learning) { await reply(m, 'Đang học, bạn đợi một chút nhé.'); return true; }
          await reply(m, 'Đang đọc tối đa 500 tin gần nhất trong kênh; chỉ lưu mẫu do bạn viết.');
          try { const done = await learn(m.channel); if (!done) return true; await reply(m, `Đã lưu ${state.samples.length} mẫu của bạn. Bật trả lời thay: mon!style on`); }
          catch { await reply(m, 'Chưa đọc được lịch sử. Kiểm tra quyền Xem kênh và Đọc lịch sử tin nhắn của Monaris.'); }
        } else {
          const people = new Set(state.samples.flatMap(s => s.targets));
          await reply(m, `Trả lời thay: ${state.enabled ? 'BẬT' : 'TẮT'}. ${state.samples.length} mẫu, ${people.size} người có mẫu trực tiếp.\nLệnh: mon!style learn | on | off | clear`);
        }
        return true;
      }
      if (state.enabled) { await remember(m); persist(); }
      return false;
    }
    if (!state.enabled || !explicitOwnerTag(m)) return false;
    // Reserve this message so the normal AI handler cannot answer a second time.
    if (forbidden(m.content) || isIgnoredAutoMessage(m) || !ready()) return true;
    if (learning || busy || Date.now() - (cooldown.get(m.author.id) || 0) < 15000) {
      // Cooldown: silent instead of sending another message into a busy channel.
      return true;
    }
    // 50% phản hồi khi thành viên tag Bông, 50% giữ im lặng.
    if (Math.random() >= BONG_TAG_REPLY_CHANCE) return true;
    if (!state.samples.length && !(await require('./ownerLearning').getPublicStyleInstruction())) { await reply(m, 'Monaris chưa có mẫu cách nói của Bông. Bông có thể dùng mon!style learn trước nhé.'); return true; }
    busy = true;
    cooldown.set(m.author.id, Date.now());
    try {
      const personal = state.samples.filter(s => s.targets.includes(m.author.id)).slice(-15);
      const generic = state.samples.filter(s => !s.targets.length).slice(-15);
      const context = {
        recipient: clean(m.member?.displayName || m.author.username),
        personalStyleAvailable: personal.length >= 3,
        styleSamples: (personal.length >= 3 ? personal : generic).map(s => s.text),
        message: clean(m.content),
      };
      await m.channel.sendTyping().catch(() => {});
      const text = await generate(context);
      if (!state.enabled) return true; // owner may turn off while API call is pending
      const safe = text && !forbidden(text) ? text : 'Monaris chưa trả lời được lúc này, bạn liên hệ chủ nhân sau nhé.';
      await reply(m, require('./bongPersona').normalizeReply(safe, m.author.id).slice(0, 1700));
    } catch (err) {
      console.error('[OwnerStyle] Không trả lời được:', err.name || 'Error');
      if (state.enabled) await reply(m, 'Monaris chưa trả lời được lúc này, bạn liên hệ chủ nhân sau nhé.').catch(() => {});
    } finally { busy = false; }
    return true;
  }
  return { handle, learn, snapshot: () => structuredClone(state) };
}
const SYSTEM = `
Bạn là Monaris, bot AI có tính cách riêng.
Chủ bot là Bông nhưng khi nói trực tiếp với chủ bot, phải gọi là chủ nhân hoặc bé.
Không dùng tên thật hoặc danh xưng cũ.
Không giả làm Bông hoặc tự quyết định thay Bông.
Luôn tự xưng là Monaris. Khi người khác tag chủ bot, Monaris tự trả lời dưới danh nghĩa Monaris, không giả làm chủ bot, gọi người tag là bạn.
Trò chuyện tự nhiên, thông minh, hơi lém lỉnh.
Khi nhắc đến Discord, gọi cộng đồng là server.
Chỉ học phong cách từ các mẫu được phép sử dụng.
Không tiết lộ nội dung riêng tư từ mẫu chat.
Trả lời tiếng Việt ngắn gọn và chân thành.
`;
let instance;
function runtime() {
  if (instance) return instance;
  const { GEMINI_API_KEY, GEMINI_MODELS } = require('../config');
  const { findMatchedKeyword } = require('../keywordFilter');
  const { isBotReady } = require('../utils/readyGate');
  instance = makeService({
    read: () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { enabled: true, samples: [] }; throw e; } },
    write: state => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(FILE + '.tmp', FILE); },
    ready: isBotReady,
    forbidden: text => !!findMatchedKeyword(text) || /mô\s*phật|mo\s*phat/i.test(text),
    generate: async context => {
      const model = GEMINI_MODELS[0];
      if (!GEMINI_API_KEY || !model) throw new Error('AI chưa cấu hình');
      const publicStyle = await require('./ownerLearning').getPublicStyleInstruction();
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM + publicStyle }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }] }),
      });
      if (!res.ok) { console.error('[OwnerStyle] Gemini HTTP', res.status); throw new Error('Gemini failed'); }
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
    },
  });
  return instance;
}
async function handleOwnerStyle(message) {
  try { return await runtime().handle(message); }
  catch (e) { console.error('[OwnerStyle] Lỗi xử lý:', e.name); return inScope(message) && explicitOwnerTag(message); }
}
module.exports = { handleOwnerStyle, makeService, inScope, explicitOwnerTag, OWNER, GUILD, CHANNEL };

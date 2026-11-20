// ===== AutoReply: listener MessageCreate =====
// Xử lý tin nhắn theo thứ tự ưu tiên: lệnh mon! -> check gear -> chưa sẵn sàng ->
// lịch scrim (0) -> giới hạn kênh chat -> "bot ơi..." (0.3) -> reply-to-bot (0.5)
// -> tag bot (0.7) -> mention (1) -> từ khóa (2) -> react vu vơ (3).

const { Events } = require('discord.js');
const client = require('../client');
const { scrimData, bcData } = require('../state');
const { isBotReady, replyNotReadyToMessage } = require('../utils/readyGate');
const { AUTOREPLY_KEYWORD_COOLDOWN_MS, AUTOREPLY_GOI_BOT_COOLDOWN_MS } = require('../config');
const { askGemini } = require('./aiClient');
const { addChatHistoryEntry, getRecentChatHistoryForChannel } = require('../googleSheets/chatHistorySheet');
const {
  KEYWORD_RESPONSES = {},
  MENTION_RESPONSES = {},
  SCRIM_QUERY_KEYWORDS = [],
  REPLY_TO_BOT_RESPONSES = [],
  GOI_BOT_KEYWORDS = [],
} = require('./keywords');
const {
  getKeywordReply,
  getChatChannelsForGuild,
  wouldTriggerBotChat,
  redirectToFixedChatChannel,
} = require('./chatRouting');
const { AI_TRIGGER_REGEX, AI_SEARCH_TRIGGER_REGEX } = require('./triggers');
const { handleKnowledgeQuestion } = require('./knowledgeQuestion');
const { handleTranslateMessage } = require('../translate');
const { handleDigestCommand } = require('./chatDigest');
const {
  getCombinedMemberDirectory,
  getMemberInfoAnySource,
  enrichMemberDirectoryWithDiscordNames,
  resolveMentionsToNames,
} = require('./memberDirectory');
const { AI_REPLY_MAX_LENGTH, sendHumanLikeReply } = require('./humanLikeReply');
const {
  detectSadSentiment,
  reactWithRandomServerEmoji,
  SPONTANEOUS_REACT_CHANCE,
  shouldReactOnlyInsteadOfReply,
  reactOnlyInsteadOfReply,
} = require('./reactions');
const { isOnAutoReplyCooldown, isRepeatedBotMention } = require('./cooldowns');
const { fetchRecentChannelMessages } = require('./channelContext');
const { isIgnoredAutoMessage, NORMAL_CHAT_REPLY_CHANCE, NORMAL_CHAT_REACT_CHANCE, CASUAL_CHAT_REPLY_CHANCE } = require('./interactionPolicy');

// FIX (bug "chọn nhầm tên đầu tiên trong danh sách Bang"): khi người tag/chat
// với bot CHƯA có trong tab "Bang"/"ChatGlobal" (chưa từng /setprofile),
// getMemberInfoAnySource() trả về null -> askGemini() không có gì để biết
// "đang nói chuyện với ai", nhưng vẫn nhét NGUYÊN danh sách đầy đủ thành viên
// bang vào prompt làm phương án dự phòng (memberDocsBlock, xem aiClient.js) ->
// AI hay tự đoán bừa và chốt nhầm luôn vào người ĐẦU TIÊN trong danh sách đó
// để xưng hô, bất kể ai đang thực sự tag/chat. Chốt cứng: LUÔN gắn kèm tên
// Discord (nickname riêng trong server nếu có, không thì username) của CHÍNH
// người đang chat vào memberInfo — aiClient.js sẽ ưu tiên tên ingame nếu có,
// không có thì bắt buộc dùng tên Discord này, KHÔNG cho AI tự đoán tên khác.
function withDiscordDisplayNameFallback(memberInfo, message) {
  const discordDisplayName =
    message.member?.displayName || message.author.displayName || message.author.username;
  return { ...(memberInfo || {}), discordDisplayName };
}

// Map tên thứ (kiểu "Thứ 4") sang đúng field trong summary trả về từ
// getVoteSummary()/getVoteDetail() (googleSheets/resultSheet.js) — dùng để
// trả lời số người đã vote khi có ai hỏi "lịch scrim" trong chat.
const DAY_VOTE_SUMMARY_FIELD = { 'Thứ 4': 'totalThu4', 'Thứ 5': 'totalThu5', 'Thứ 6': 'totalThu6' };

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  // MONARIS_MECH_BOSS_GUARD
  if (require('../mechBoss').isMechRequest(message)) return;
  // MONARIS_OWNER_STYLE_V1
  if (await require('./ownerStyle').handleOwnerStyle(message)) return;

  const content = message.content.trim().toLowerCase();

  // Bỏ qua tin nhắn bắt đầu bằng "mon!" — đó là namespace của các lệnh
  // trong commands/messageCommands.js, không để keyword ở đây đụng vào.
  if (content.startsWith('mon!')) return;
  // Chặn tự động trả lời / reaction với lệnh, link hoặc nội dung nhạy cảm.
  // Listener lệnh Discord khác vẫn xử lý độc lập.
  if (isIgnoredAutoMessage(message)) return;

  // Reply vào bài Check Gear của bot (hoặc vào tin của bot trong chủ đề thảo
  // luận bài đó) là để người với người bàn với nhau, checkGear/discussion.js
  // lo việc tạo chủ đề — KHÔNG để tính năng "reply-to-bot" bên dưới chat xen vào.

  // Bot chưa nạp xong dữ liệu khởi động (xem utils/readyGate.js) — CHỈ trả
  // lời "đang nạp" khi tin nhắn THỰC SỰ đang gọi bot (tag/từ khóa/"bot ơi,
  // ..."/hỏi lịch scrim), tin nhắn chat bình thường khác vẫn im lặng bỏ qua
  // như cũ để không spam cả kênh trong lúc bot đang khởi động.
  if (!isBotReady()) {
    const isScrimQueryEarly = SCRIM_QUERY_KEYWORDS.some((phrase) => content.includes(phrase.toLowerCase()));
    if (isScrimQueryEarly || wouldTriggerBotChat(message, content)) {
      await replyNotReadyToMessage(message);
    }
    return;
  }

  // MONARIS_OWNER_PRIVATE_CHAT_V1
  // Trong kênh riêng, chủ bot có thể nói chuyện
  // tự nhiên mà không cần tag hoặc dùng từ khóa.
  if (
    message.guildId === '1566691700850688013' &&
    message.channelId === '1566701909270601758' &&
    message.author.id === '1398428399357268068'
  ) {
    const userText = message.content.trim();
    if (!userText) return;

    try {
      await message.channel.sendTyping();

      const memberInfo = withDiscordDisplayNameFallback(
        await getMemberInfoAnySource(message.author.id),
        message
      );

      // Lấy một ít hội thoại gần đây của chính chủ bot.
      // Chỉ dùng làm ngữ cảnh, không ghi vào log chung.
      const previous = await message.channel.messages.fetch({
        limit: 15,
        before: message.id
      }).catch(() => null);

      const channelMessages = previous
        ? [...previous.values()]
            .filter(m =>
              m.author?.id === message.author.id &&
              m.content?.trim()
            )
            .reverse()
            .map(m => ({
              time: new Date(m.createdTimestamp).toISOString(),
              label: 'bé',
              text: m.content.slice(0, 450)
            }))
        : [];

      const aiReply = await askGemini(
        userText +
        '\n\nLưu ý: Nếu được hỏi về điều đã ghi nhớ, ' +
        'chỉ trả lời dựa trên dữ liệu trí nhớ hoặc ' +
        'hội thoại có thật. Nếu chưa có thì nói rõ, ' +
        'không tự đoán.',
        {
          memberInfo,
          memberDirectory: [],
          chatHistory: [],
          channelMessages,
          scrimData,
          bcData,
          channelId: message.channelId,
          requesterId: message.author.id
        }
      );

      if (aiReply) {
        await sendHumanLikeReply(
          message.channel,
          aiReply,
          {
            replyToMessage: message,
            guild: message.guild
          }
        );
      } else {
        await message.reply({
          content:
            'Bé ơi, Monaris chưa gọi được AI. ' +
            'Kiểm tra log Gemini giúp Monaris nha.',
          allowedMentions: { repliedUser: false }
        });
      }
    } catch (error) {
      console.error(
        '[OwnerPrivateChat] Lỗi:',
        error
      );

      await message.reply({
        content:
          'Bé ơi, Monaris gặp lỗi khi trả lời. ' +
          'Kiểm tra CMD giúp Monaris nhé.',
        allowedMentions: { repliedUser: false }
      }).catch(() => {});
    }

    return;
  }

  // 0.0) Lệnh dịch: "bot dịch [ngôn ngữ], <câu>" / reply "bot dịch [ngôn ngữ]" /
  // "dịch giúp tôi, <câu>" — xem translate/index.js. CHỦ Ý đặt TRƯỚC cả câu hỏi lịch
  // scrim lẫn khối giới hạn kênh chat cố định bên dưới: người dùng cần dịch ở đâu thì
  // bot trả lời ở đó (không bị ràng buộc kênh chat đã set bằng mon!setchatchannel), và
  // câu cần dịch có chứa từ như "lịch scrim" cũng không bị trả lời nhầm thành lịch scrim.
  // 0.05) "hey @bot tóm tắt 1/2/3 tiếng qua" — tóm tắt chat kênh bằng AI, xem AutoReply/chatDigest.js. CHỦ Ý đặt TRƯỚC
  // khối giới hạn kênh chat cố định (mon!setchatchannel) bên dưới: lệnh này gọi ở kênh nào cũng được. Trả true thì dừng,
  // không cho nhánh tag-bot/từ khoá xen vào trả lời thêm.
  if (await handleDigestCommand(message)) return;

  if (require('../features').isEnabled('translate') && (await handleTranslateMessage(message))) return;

  // 0) "Lịch scrim tuần này" — trả lời dựa trên dữ liệu THỰC TẾ hiện tại
  // trong scrimData (được Bông cập nhật qua mon!us1 / mon!us2 mỗi tuần), khác
  // với KEYWORD_RESPONSES vì câu trả lời không cố định mà đọc state sống.
  //
  // CHỦ Ý ĐẶT TRƯỚC khối giới hạn kênh chat cố định bên dưới: câu hỏi
  // "lịch scrim" cần trả lời được ở BẤT KỲ kênh nào, kể cả khi server đã
  // set kênh chat cố định bằng mon!setchatchannel — không bị giới hạn như
  // các tính năng chat khác (từ khóa, tag bot, "bot ơi, ...").
  const isScrimQuery = SCRIM_QUERY_KEYWORDS.some((phrase) => content.includes(phrase.toLowerCase()));

  // Câu hỏi lịch scrim do bot BANG trả lời (scrim/queryReply.js) — bot gốc im lặng để không trả lời trùng / AI chat chen vào.
  if (isScrimQuery) return;

  // Kênh chat CỐ ĐỊNH do admin từng server tự set bằng mon!setchatchannel
  // (state.chatChannels, map guildId -> channelId). Server ĐÃ set thì toàn
  // bộ tính năng trò chuyện bên dưới (từ khóa, tag bot, "bot ơi, ...",
  // reply-to-bot, ...) CHỈ hoạt động trong đúng kênh đó. Server CHƯA set
  // (chưa có trong map, kể cả server gốc) thì giữ nguyên hành vi mặc định
  // — trả lời ở bất kỳ kênh nào có người nhắn, không bị giới hạn gì cả.
  //
  // NGOẠI LỆ: kênh chat của voice channel (tab nhắn tin bên trong 1 kênh
  // thoại) KHÔNG bị áp dụng giới hạn này — hiện tại CHƯA muốn giới hạn bot
  // chat ở khu vực voice, nên bỏ qua toàn bộ check bên dưới nếu tin nhắn
  // đến từ 1 voice channel, coi như luôn được phép chat tự do ở đó.
  if (message.guild && !message.channel.isVoiceBased()) {
    const fixedChatChannelIds = getChatChannelsForGuild(message.guild.id);
    if (fixedChatChannelIds.length > 0 && !fixedChatChannelIds.includes(message.channelId)) {
      // Chỉ redirect khi tin nhắn THỰC SỰ đang gọi bot (mention/từ khóa/
      // "bot ơi, ...") — tin nhắn bình thường khác thì vẫn im lặng bỏ qua
      // như cũ, tránh redirect tràn lan gây phiền cho những cuộc trò
      // chuyện không liên quan gì tới bot.
      if (wouldTriggerBotChat(message, content)) {
        await redirectToFixedChatChannel(message);
      }
      return;
    }
  }

  // 0.2) Hỏi kho kiến thức bang bằng dấu "?" ở cuối: "cửu linh build pvp ?" (khớp từ khoá thì bot trả lời) /
  // "bot, abc xyz ?" (gọi thẳng bot thì luôn trả lời). Xem AutoReply/knowledgeQuestion.js. Đặt SAU khối giới hạn
  // kênh chat ở trên (tôn trọng mon!setchatchannel) và TRƯỚC "bot ơi," / reply-to-bot / tag bot / từ khoá: tin không
  // phải câu hỏi kiểu này trả false nên các luồng bên dưới chạy y như cũ.
  if (await handleKnowledgeQuestion(message)) return;

  // Công tắc web "Bot trò chuyện (AI)": tắt thì bỏ qua mọi nhánh trò chuyện bên dưới (gọi bot, reply, tag, từ khoá, react vu vơ).
  if (!require('../features').isEnabled('aichat')) return;

  // 0.3) "bot ơi, <yêu cầu>" / "ê bot, <yêu cầu>" / ... (chat thường) hoặc
  // "bot ơi tìm, <yêu cầu>" / "tìm giúp tôi, <yêu cầu>" (có kèm search) —
  // nhờ AI (Gemini) xử lý 1 yêu cầu "tự do" không có sẵn trong
  // KEYWORD_RESPONSES. Check search trigger TRƯỚC vì nó cụ thể hơn (có
  // thêm từ "tìm"/là 1 cụm khác). Đặt TRƯỚC check reply-to-bot/mention/
  // keyword vì đây là tín hiệu rõ ràng nhất là đang nhờ bot làm gì đó.
  const trimmedContent = message.content.trim();
  const searchMatch = trimmedContent.match(AI_SEARCH_TRIGGER_REGEX);
  const aiMatch = searchMatch || trimmedContent.match(AI_TRIGGER_REGEX);

  if (aiMatch) {
    const userRequest = aiMatch[1].trim();
    if (userRequest) {
      try {
        await message.channel.sendTyping();
        const memberInfo = withDiscordDisplayNameFallback(
          await getMemberInfoAnySource(message.author.id),
          message
        );
        const memberDirectory = enrichMemberDirectoryWithDiscordNames(await getCombinedMemberDirectory(), message.guild);
        const chatHistory = getRecentChatHistoryForChannel(message.channelId);
        // "Đọc không khí kênh": các tin gần nhất của mọi người ngay trước tin này (xem channelContext.js).
        const channelMessages = await fetchRecentChannelMessages(message.channel, {
          beforeMessageId: message.id,
          memberDirectory,
        });
        // Resolve <@ID> -> tên thật TRƯỚC khi đưa vào AI, xem giải thích ở
        // resolveMentionsToNames() phía trên (bug trả lời nhầm người bị mention).
        const resolvedUserRequest = resolveMentionsToNames(userRequest, message, memberDirectory);
        const aiReply = await askGemini(resolvedUserRequest, {
          useSearch: Boolean(searchMatch),
          memberInfo,
          memberDirectory,
          chatHistory,
          channelMessages,
          scrimData,
          bcData,
          channelId: message.channelId,
          requesterId: message.author.id,
        });
        const replyText =
          aiReply || 'Bot chưa trả lời được yêu cầu này (chưa cấu hình AI hoặc lỗi tạm thời), thử lại sau nha 😅';
        await sendHumanLikeReply(message.channel, replyText, { replyToMessage: message, guild: message.guild });

        if (aiReply) {
          await addChatHistoryEntry({
            channelId: message.channelId,
            userId: message.author.id,
            userDisplayName: message.author.displayName || message.author.username,
            userMessage: resolvedUserRequest,
            botReply: aiReply,
          });
        }
      } catch (error) {
        console.error('Lỗi khi xử lý yêu cầu AI:', error.message);
      }
      return;
    }
  }

  // 0.5) Nếu người dùng REPLY thẳng vào tin nhắn mà BOT gửi (không phải
  // reply vào tin người khác) thì bot đáp lại luôn, bất kể nội dung là gì.
  // Ưu tiên cao vì đây là tín hiệu rõ ràng nhất là đang nói chuyện với bot.
  // Dùng AI để trả lời 1 câu NGẮN GỌN, tự nhiên theo đúng tính cách bot;
  // nếu AI lỗi/chưa cấu hình thì fallback về REPLY_TO_BOT_RESPONSES cố định.
  if (message.reference?.messageId) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);

      if (repliedMessage.author.id === client.user.id) {
        // Only 30% of casual replies to Monaris get a text response.
        if (Math.random() >= CASUAL_CHAT_REPLY_CHANCE) return;
        // Thỉnh thoảng chỉ thả react qua loa thay vì gõ hẳn 1 câu — giống
        // bạn bè thật đôi lúc lười gõ, không phải lúc nào cũng cần trả lời
        // đầy đủ cho mọi tin nhắn nhỏ.
        if (
  message.author.id !== '1398428399357268068' &&
  shouldReactOnlyInsteadOfReply()
) {
          try {
            await reactOnlyInsteadOfReply(message);
          } catch (error) {
            console.error('Không thể thả react-only cho reply-to-bot:', error.message);
          }
          return;
        }

        try {
          await message.channel.sendTyping();
          const memberInfo = withDiscordDisplayNameFallback(
            await getMemberInfoAnySource(message.author.id),
            message
          );
          const memberDirectory = enrichMemberDirectoryWithDiscordNames(await getCombinedMemberDirectory(), message.guild);
          const chatHistory = getRecentChatHistoryForChannel(message.channelId);
          const channelMessages = await fetchRecentChannelMessages(message.channel, {
            beforeMessageId: message.id,
            memberDirectory,
          });
          // Resolve <@ID> -> tên thật TRƯỚC khi đưa vào AI, xem giải thích ở
          // resolveMentionsToNames() phía trên (bug trả lời nhầm người bị mention).
          const resolvedContent = resolveMentionsToNames(message.content, message, memberDirectory);
          const aiReply = await askGemini(
            `Người dùng vừa reply lại tin nhắn bạn gửi trước đó. Nội dung reply của họ: ` +
              `"${resolvedContent}". Đáp lại NGẮN GỌN, tự nhiên, đúng tính cách của bạn — 1 câu ` +
              `là đủ, không cần dài dòng, không quá ${AI_REPLY_MAX_LENGTH} ký tự.`,
            { memberInfo, memberDirectory, chatHistory, channelMessages, scrimData, bcData, channelId: message.channelId, requesterId: message.author.id }
          );

          const fallback = Array.isArray(REPLY_TO_BOT_RESPONSES)
            ? REPLY_TO_BOT_RESPONSES[Math.floor(Math.random() * REPLY_TO_BOT_RESPONSES.length)]
            : REPLY_TO_BOT_RESPONSES;

          const replyText = aiReply || fallback;
          await sendHumanLikeReply(message.channel, replyText, { replyToMessage: message, guild: message.guild });

          if (aiReply) {
            await addChatHistoryEntry({
              channelId: message.channelId,
              userId: message.author.id,
              userDisplayName: message.author.displayName || message.author.username,
              userMessage: resolvedContent,
              botReply: aiReply,
            });
          }
        } catch (error) {
          console.error('Lỗi khi tạo AI reply cho reply-to-bot:', error.message);
        }
        return;
      }
    } catch (error) {
      // Tin nhắn gốc có thể đã bị xóa hoặc không fetch được — bỏ qua,
      // để logic keyword/mention bên dưới chạy tiếp bình thường.
      console.error('Failed to fetch/check replied message:', error.message);
    }
  }
  // 0.7) Người dùng TAG TRỰC TIẾP bot (@TênBot) trong tin nhắn — KHÔNG phải
  // reply (đã xử lý ở 0.5) và KHÔNG phải theo cú pháp "bot ơi, ..." (đã xử
  // lý ở 0.3). Dùng AI trả lời tự động, giống hệt logic reply-to-bot ở
  // trên. KHÔNG cooldown chặn cứng — tag trực tiếp thì LUÔN có phản hồi mỗi
  // lần, cooldown chặn hẳn chỉ áp dụng cho trigger theo TỪ KHÓA (mục 2 bên
  // dưới). Tuy nhiên NẾU cùng 1 người tag liên tục dồn dập (xem
  // isRepeatedBotMention ngay dưới) thì đổi CÁCH phản hồi cho tự nhiên hơn.
  if (message.mentions.users.has(client.user.id)) {
    if (Math.random() >= CASUAL_CHAT_REPLY_CHANCE) return;
const isBong =
  message.author.id === '1398428399357268068';
    const isRepeatedMention = isRepeatedBotMention(`${message.channelId}:mention:${message.author.id}`);

    // Thỉnh thoảng chỉ thả react qua loa thay vì gõ hẳn 1 câu — xem giải
    // thích ở nhánh reply-to-bot (0.5) phía trên.
    if (!isBong && shouldReactOnlyInsteadOfReply()) {
      try {
        await reactOnlyInsteadOfReply(message);
      } catch (error) {
        console.error('Không thể thả react-only cho bot mention:', error.message);
      }
      return;
    }

    // Bị CHÍNH người này tag liên tục trong khung dồn dập (BOT_MENTION_COOLDOWN_MS,
    // mặc định 5 phút) — 60% khả năng KHÔNG gọi AI nữa, thay vào đó random
    // giữa chỉ react qua loa hoặc 1 câu cố định ngắn có sẵn (REPLY_TO_BOT_RESPONSES
    // đã có sẵn nhiều câu kiểu hơi cạn lời/bực mình) — vừa đỡ tốn quota Gemini,
    // vừa giống người thật bắt đầu lười/hơi bực khi bị tag liên tục thay vì lúc
    // nào cũng hào hứng trả lời đầy đủ như lần đầu.
    if (!isBong && isRepeatedMention && Math.random() < 0.6) {
      try {
        if (Math.random() < 0.5) {
          await reactOnlyInsteadOfReply(message);
        } else {
          const fallback = Array.isArray(REPLY_TO_BOT_RESPONSES)
            ? REPLY_TO_BOT_RESPONSES[Math.floor(Math.random() * REPLY_TO_BOT_RESPONSES.length)]
            : REPLY_TO_BOT_RESPONSES;
          await sendHumanLikeReply(message.channel, fallback, { replyToMessage: message, guild: message.guild });
        }
      } catch (error) {
        console.error('Không thể phản hồi lượt tag dồn dập:', error.message);
      }
      return;
    }

    try {
      await message.channel.sendTyping();
      const memberInfo = withDiscordDisplayNameFallback(
        await getMemberInfoAnySource(message.author.id),
        message
      );
      const memberDirectory = enrichMemberDirectoryWithDiscordNames(await getCombinedMemberDirectory(), message.guild);
      const chatHistory = getRecentChatHistoryForChannel(message.channelId);
      const channelMessages = await fetchRecentChannelMessages(message.channel, {
        beforeMessageId: message.id,
        memberDirectory,
      });
      // Resolve <@ID> -> tên thật TRƯỚC khi đưa vào AI, xem giải thích ở
      // resolveMentionsToNames() phía trên (bug trả lời nhầm người bị mention).
      const resolvedContent = resolveMentionsToNames(message.content, message, memberDirectory);
      const aiReply = await askGemini(
        `Người dùng vừa tag thẳng bạn trong tin nhắn: "${resolvedContent}". Đáp lại ` +
          `NGẮN GỌN, tự nhiên, đúng tính cách của bạn — 1 câu là đủ, không cần dài dòng, ` +
          `không quá ${AI_REPLY_MAX_LENGTH} ký tự.`,
        { memberInfo, memberDirectory, chatHistory, channelMessages, scrimData, bcData, channelId: message.channelId, requesterId: message.author.id }
      );

      const fallback = Array.isArray(REPLY_TO_BOT_RESPONSES)
        ? REPLY_TO_BOT_RESPONSES[Math.floor(Math.random() * REPLY_TO_BOT_RESPONSES.length)]
        : REPLY_TO_BOT_RESPONSES;

      const replyText = aiReply || fallback;
      await sendHumanLikeReply(message.channel, replyText, { replyToMessage: message, guild: message.guild });

      if (aiReply) {
        await addChatHistoryEntry({
          channelId: message.channelId,
          userId: message.author.id,
          userDisplayName: message.author.displayName || message.author.username,
          userMessage: resolvedContent,
          botReply: aiReply,
        });
      }
    } catch (error) {
      console.error('Lỗi khi tạo AI reply cho bot mention:', error.message);
    }
    return;
  }

  // 1) Check mention — nếu tin nhắn có TAG THẬT (@user) tới 1 user
  // trong danh sách MENTION_RESPONSES thì bot trả lời hộ.
  for (const [userId, response] of Object.entries(MENTION_RESPONSES)) {
    const isRealMention = message.content.includes(`<@${userId}>`) || message.content.includes(`<@!${userId}>`);

    if (isRealMention) {
      if (isOnAutoReplyCooldown(`${message.channelId}:mention:${userId}`)) {
        // Đang cooldown — không chat được thì thả react thay thế, giống
        // hệt cơ chế bot-mention ở trên, rồi thử tiếp các mention khác
        // trong tin nhắn (nếu có) thay vì return luôn.
        // Khi dang cooldown, im lang thay vi gui them tin nhan dang ban.
        return;
      }

      const reply = Array.isArray(response)
        ? response[Math.floor(Math.random() * response.length)]
        : response;

      try {
        await message.reply(reply);
      } catch (error) {
        console.error(`Failed to send mention auto-reply for user ${userId}:`, error.message);
      }
      return;
    }
  }

  // 2) Rồi mới check từ khóa. Chỉ trigger từ khóa ĐẦU TIÊN khớp được
  // (tránh spam nhiều reply nếu 1 tin nhắn vô tình chứa nhiều từ khóa).
  // 50% dùng AI tạo câu trả lời bám theo đúng từ khóa/ngữ cảnh tin nhắn, 50%
  // dùng câu cố định trong KEYWORD_RESPONSES như cũ — xem getKeywordReply.
  // Cooldown TÁCH RIÊNG 2 nhóm trong cùng 1 kênh:
  //   - Nhóm "gọi bot" trống không (GOI_BOT_KEYWORDS: con bot/bot đâu/bot
  //     ơi/bot à) dùng pool cooldown RIÊNG (AUTOREPLY_GOI_BOT_COOLDOWN_MS,
  //     mặc định 10 phút) — vì đây là cách gọi bot thông thường/thường
  //     xuyên nhất, không muốn giãn cách quá lâu.
  //   - TẤT CẢ từ khóa còn lại dùng CHUNG 1 pool (AUTOREPLY_KEYWORD_COOLDOWN_MS,
  //     mặc định 30 phút) — hễ 1 từ khóa (không phải "gọi bot") bất kỳ vừa
  //     trigger reply thì toàn bộ từ khóa khác trong nhóm này ở cùng kênh
  //     cũng bị cooldown theo luôn, tới khi hết 30 phút mới trigger lại
  //     được (bất kể từ khóa nào trong nhóm).
  // 2 pool này độc lập nhau: đang cooldown nhóm này không ảnh hưởng nhóm kia.
  for (const [keyword, response] of Object.entries(KEYWORD_RESPONSES)) {
    if (content.includes(keyword.toLowerCase())) {
      const isGoiBotKeyword = GOI_BOT_KEYWORDS.includes(keyword);
      if (Math.random() >= CASUAL_CHAT_REPLY_CHANCE) return;
      // Trước đây TẤT CẢ từ khóa (trừ nhóm gọi bot) dùng CHUNG 1 cooldownKey
      // theo kênh -> hễ 1 từ khóa bất kỳ trigger là mọi từ khóa KHÁC trong
      // cùng kênh cũng bị khoá theo suốt 30 phút, khiến bot toàn thả react
      // thay vì trả lời ở kênh chat sôi nổi. Đổi sang cooldown RIÊNG theo
      // từng keyword (vẫn theo kênh) — chỉ khoá đúng keyword vừa trigger,
      // các keyword khác không bị ảnh hưởng.
      const cooldownKey = isGoiBotKeyword
        ? `${message.channelId}:keyword:goibot`
        : `${message.channelId}:keyword:${keyword}`;
      const cooldownMs = isGoiBotKeyword ? AUTOREPLY_GOI_BOT_COOLDOWN_MS : AUTOREPLY_KEYWORD_COOLDOWN_MS;

      if (isOnAutoReplyCooldown(cooldownKey, cooldownMs)) {
        // Đang cooldown — không chat được thì thả react thay thế, rồi thử
        // tiếp các từ khóa khác trong tin nhắn (nếu có) thay vì return luôn.
        await message.reply({ content: 'Monaris đang bận, liên hệ lại sau nhé', allowedMentions: { repliedUser: false } }).catch(() => {});
        return;
      }

      // Thỉnh thoảng chỉ thả react qua loa thay vì gõ hẳn 1 câu — xem giải
      // thích ở nhánh reply-to-bot (0.5). Không áp dụng cho nhóm "gọi bot"
      // (GOI_BOT_KEYWORDS) — người ta đang chủ động gọi tên bot thì im re
      // chỉ react dễ bị hiểu lầm là bot lỗi/không thấy.
      if (!isGoiBotKeyword && shouldReactOnlyInsteadOfReply()) {
        try {
          await reactOnlyInsteadOfReply(message);
        } catch (error) {
          console.error(`Không thể thả react-only cho keyword "${keyword}":`, error.message);
        }
        return;
      }

      const reply = message.author.id === '1398428399357268068' && isGoiBotKeyword
        ? (Math.random() < 0.5 ? 'Monaris đây, chủ nhân gọi Monaris ạ?' : 'Monaris nghe nè bé, bé cần gì?')
        : await getKeywordReply(keyword, response, message.content, message.author.id, message.guild, message.channelId, message.id);

      try {
        await sendHumanLikeReply(message.channel, reply, { guild: message.guild });
      } catch (error) {
        console.error(`Failed to send auto-reply for keyword "${keyword}":`, error.message);
      }
      return;
    }
  }

  // 3) Trò chuyện bình thường: 100% thử react và 20% tham gia bằng AI.
  // Chỉ đến đây khi không có lệnh, trigger, mention, hay yêu cầu riêng.
  // React là best-effort: thiếu quyền Add Reactions không làm chặn chat.
  if (Math.random() < NORMAL_CHAT_REACT_CHANCE) {
    try {
      await reactWithRandomServerEmoji(message);
    } catch (error) {
      console.error('Không thể thả react trò chuyện bình thường:', error.message);
    }
  }

  if (Math.random() < NORMAL_CHAT_REPLY_CHANCE) {
    try {
      const memberInfo = withDiscordDisplayNameFallback(
        await getMemberInfoAnySource(message.author.id),
        message
      );
      const memberDirectory = enrichMemberDirectoryWithDiscordNames(
        await getCombinedMemberDirectory(), message.guild
      );
      const channelMessages = await fetchRecentChannelMessages(message.channel, {
        beforeMessageId: message.id,
        memberDirectory,
      });
      const resolvedContent = resolveMentionsToNames(message.content, message, memberDirectory);
      const aiReply = await askGemini(
        `Mọi người đang trò chuyện bình thường. Tin nhắn gần nhất: "${resolvedContent}". ` +
        `Chỉ góp một câu ngắn, tự nhiên, phù hợp mạch hội thoại như bạn bè. ` +
        `Không chen vào nội dung riêng tư, không tự xưng là Bông, tối đa ${AI_REPLY_MAX_LENGTH} ký tự.`,
        {
          memberInfo, memberDirectory, channelMessages,
          chatHistory: getRecentChatHistoryForChannel(message.channelId),
          scrimData, bcData, channelId: message.channelId,
          requesterId: message.author.id,
        }
      );
      if (aiReply) {
        await sendHumanLikeReply(message.channel, aiReply, { guild: message.guild });
      }
    } catch (error) {
      console.error('Không thể tham gia trò chuyện bình thường:', error.message);
    }
  }

});

module.exports = {

};

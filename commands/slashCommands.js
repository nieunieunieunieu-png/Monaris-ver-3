// ===== Slash commands + nút (interaction): điều phối chung =====
// Module này giờ chỉ giữ listener Events.InteractionCreate ở dạng "dispatcher": gate
// "chưa sẵn sàng", xử lý nút, rồi trong khối try/catch gọi lần lượt từng nhóm lệnh
// (mỗi nhóm trả true nếu đã xử lý -> dừng, giống `return;` ở listener gốc). Các lệnh
// đều so khớp chính xác theo commandName và không trùng nhau nên thứ tự các nhóm không
// ảnh hưởng kết quả. Re-export applySetMqh cho commands/messageCommands.js như cũ.
//   - slashMisc.js     : /ping /help /hi /moe /tlmn /ai + kênh chat cố định (/join /out đã gỡ đăng ký, không còn tác dụng)
//   - slashNotice.js   : /addnotice /removenotice /viewnotice /testnotice + Auto DM
//   - slashProfile.js  : /setpf /setmqh role Bông + applySetMqh (dùng chung với mon!setmqh)

const { Events } = require('discord.js');
const client = require('../client');
const { isBotReady, replyNotReadyToInteraction } = require('../utils/readyGate');
const {
  handleNoticeApprovalButton,
  NOTICE_APPROVE_BUTTON_PREFIX,
  NOTICE_REJECT_BUTTON_PREFIX,
} = require('./noticeApproval');
const { handleMiscSlashCommands } = require('./slashMisc');
const { handleNoticeSlashCommands } = require('./slashNotice');
const { applySetMqh, handleProfileSlashCommands } = require('./slashProfile');
const { handleTranslateSlashCommands } = require('./slashTranslate');

// Tên các slash command KHÔNG do file này xử lý (thuộc thiKiem/index.js) —
// dùng để loại trừ khi kiểm tra "interaction này có phải do file này xử lý
// không" cho phần gate "chưa sẵn sàng" bên dưới, tránh trả lời trùng với
// listener InteractionCreate riêng của thiKiem/index.js (và level/index.js: /level /toplevel /expinfo /levelsync /expadd /expset).
const NON_LOCAL_COMMAND_NAMES = new Set(['tatbot', 'trangthai', 'set-mua-giai', 'xoa-diem-thi-kiem', 'xem-bang-xep-hang-thi-kiem', 'level', 'toplevel', 'topstreak', 'nhacstreak', 'expinfo', 'levelsync', 'levelnotify', 'profile', 'profilexoa', 'shopkhung', 'shopcap', 'expadd', 'expset', 'addpoint', 'logtim', 'baocaothang', 'toprole', 'themthanhtuu', 'suathanhtuu', 'xoathanhtuu', 'dsthanhtuu', 'whotagme', 'congduc', 'topcongduc', 'cuahangcongduc', 'canhgioi', 'hosocd', 'bang-nhanvat', 'nhanvat', 'xoa-nhanvat', 'phoban12', 'tarot']);

client.on(Events.InteractionCreate, async (interaction) => {
  // Bot chưa nạp xong dữ liệu khởi động (xem utils/readyGate.js) — CHỈ chặn
  // đúng những tương tác mà bản thân file này sẽ xử lý bên dưới (nút/slash
  // command của nó), KHÔNG chặn tương tác của feedbackBox/thiKiem (các file
  // đó đã tự gate riêng) để tránh trả lời trùng 2 lần cho cùng 1 tương tác.
  const isLocalButton =
    interaction.isButton() &&
    (interaction.customId.startsWith(NOTICE_APPROVE_BUTTON_PREFIX) ||
      interaction.customId.startsWith(NOTICE_REJECT_BUTTON_PREFIX));
  const isLocalCommand = interaction.isChatInputCommand() && !NON_LOCAL_COMMAND_NAMES.has(interaction.commandName);

  if (!isBotReady() && (isLocalButton || isLocalCommand)) {
    await replyNotReadyToInteraction(interaction);
    return;
  }

  if (interaction.isButton()) {
    let handler = null;
    if (
      interaction.customId.startsWith(NOTICE_APPROVE_BUTTON_PREFIX) ||
      interaction.customId.startsWith(NOTICE_REJECT_BUTTON_PREFIX)
    )
      handler = handleNoticeApprovalButton;

    if (handler) {
      await handler(interaction).catch((error) => {
        console.error('Error handling button interaction:', error.message);
      });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // Lệnh gộp (/upload /usi /post /rpost /where + option loai) được dịch về tên lệnh cũ để handler không phải đổi.
  const commandName = interaction.commandName;

  try {
    if (await handleMiscSlashCommands(interaction, commandName)) return;

    if (await handleNoticeSlashCommands(interaction, commandName)) return;

    if (await handleProfileSlashCommands(interaction, commandName)) return;

    if (await handleTranslateSlashCommands(interaction, commandName)) return;
  } catch (error) {
    console.error(`Error handling slash command /${commandName}:`, error.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('❌ Đã xảy ra lỗi khi xử lý lệnh.').catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Đã xảy ra lỗi khi xử lý lệnh.', ephemeral: true }).catch(() => {});
    }
  }
});

// applySetMqh export ra để commands/messageCommands.js dùng CHUNG logic
// set/validate quan hệ cho bản mon!setmqh — tránh viết lại lần 2.
module.exports = { applySetMqh };

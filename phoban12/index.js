
'use strict';

const {
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} = require('discord.js');

const { google } = require('../googleSheets/googleClient');
const { getGoogleAuthClient } = require('../googleSheets/auth');
const client = require('../client');

// ==========================================
// CAU HINH
// ==========================================

const SHEET_ID =
  process.env.PHOBAN12_SPREADSHEET_ID ||
  '1gEIRbebFXvVrQ3zOHueHyzXDXySTBTO6B1MuGjcv_O8';

const GUILD_ID =
  process.env.DISCORD_GUILD_ID ||
  '1566691700850688013';

const PREFIX = 'p12:';

const EPHEMERAL = {
  flags: MessageFlags.Ephemeral
};

const CLASSES = [
  'Tố Vấn',
  'Thiết Y',
  'Huyết Hà',
  'Thần Tương',
  'Cửu Linh',
  'Toái Mộng',
  'Long Ngâm'
];

const PHOBAN12_SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('phoban12')
    .setDescription('Tạo bảng báo danh phó bản 12 người')
    .toJSON()
];

// Khóa theo từng vote để tránh hai người
// cùng chiếm suất cuối cùng của một team.
const locks = new Map();

async function withVoteLock(voteId, task) {
  const previous = locks.get(voteId) || Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(task);

  locks.set(voteId, current);

  try {
    return await current;
  } finally {
    if (locks.get(voteId) === current) {
      locks.delete(voteId);
    }
  }
}

function active(entry) {
  return (
    entry.status === 'ON' ||
    entry.status === 'LATE'
  );
}

function cleanInput(value, max = 100) {
  return String(value || '')
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max);
}

// ==========================================
// GOOGLE SHEETS
// ==========================================

async function getApi() {
  const auth = await getGoogleAuthClient();

  if (!auth) {
    throw new Error(
      'Google Sheets chưa được xác thực'
    );
  }

  return google.sheets({
    version: 'v4',
    auth
  });
}

async function readRows(api, range) {
  const response = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  return response.data.values || [];
}

async function appendRow(api, sheet, values) {
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${sheet}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values]
    }
  });
}

async function updateEntry(api, entry) {
  const row = entry.rowNumber;

  if (!row || row < 2) {
    throw new Error(
      'Không xác định được dòng dữ liệu người chơi'
    );
  }

  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'Phoban12_Entries'!A${row}:I${row}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [entryValues(entry)]
    }
  });
}

function entryValues(entry) {
  return [
    entry.voteId,
    entry.userId,
    entry.userName,
    entry.characterName,
    entry.className,
    entry.status,
    entry.team,
    entry.updatedAt,
    entry.sequence
  ];
}

async function findVote(api, voteId) {
  const rows = await readRows(
    api,
    "'Phoban12_Votes'!A2:I2000"
  );

  const row = rows.find(
    r => String(r[0] || '') === String(voteId)
  );

  if (!row) return null;

  return {
    id: String(row[0] || ''),
    guildId: String(row[1] || ''),
    channelId: String(row[2] || ''),
    messageId: String(row[3] || ''),
    time: String(row[4] || ''),
    creatorId: String(row[5] || ''),
    createdAt: String(row[6] || ''),
    status: String(row[7] || ''),
    dungeonName:
      String(row[8] || 'Phó bản 12 người')
  };
}

async function loadEntries(api, voteId) {
  const rows = await readRows(
    api,
    "'Phoban12_Entries'!A2:I5000"
  );

  return rows
    .map((r, index) => ({
      rowNumber: index + 2,
      voteId: String(r[0] || ''),
      userId: String(r[1] || ''),
      userName: String(r[2] || ''),
      characterName: String(r[3] || ''),
      className: String(r[4] || ''),
      status: String(r[5] || ''),
      team: String(r[6] || ''),
      updatedAt: String(r[7] || ''),
      sequence: Number(r[8]) || 0
    }))
    .filter(entry => entry.voteId === voteId);
}

async function getCharacterProfile(api, userId) {
  const rows = await readRows(
    api,
    "'Character_Profiles'!A2:D1000"
  );

  const matches = rows.filter(
    row => String(row[0] || '') === String(userId)
  );

  const row = matches.reverse().find(
    r => String(r[3] || '').trim()
  );

  if (!row) return null;

  return {
    name: String(row[2] || '').slice(0, 80),
    className: String(row[3] || '').trim()
  };
}

// ==========================================
// XEP DOI
// ==========================================

// KHONG gioi han To Van / Thiet Y.
// Chi gioi han toi da 6 nguoi / team.
//
// Uu tien Team 1 truoc.
// Khi Team 1 du 6 nguoi, chuyen sang Team 2.

function findAvailableTeam(entries) {
  for (const team of ['1', '2']) {
    const members = entries.filter(
      entry =>
        active(entry) &&
        entry.team === team
    );

    if (members.length < 6) {
      return team;
    }
  }

  return null;
}

function teamMembers(entries, team) {
  return entries
    .filter(
      entry =>
        active(entry) &&
        entry.team === team
    )
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.rowNumber - b.rowNumber
    );
}

function formatTeam(entries, team) {
  const members = teamMembers(entries, team);

  const lines = members.map((entry, index) => {
    const late =
      entry.status === 'LATE' ? ' 🕒' : '';

    return (
      `${index + 1}. <@${entry.userId}>` +
      ` — ${entry.className || 'Chưa rõ'}${late}`
    );
  });

  for (let i = members.length; i < 6; i++) {
    lines.push(`${i + 1}. *Trống*`);
  }

  return lines.join('\n');
}

// ==========================================
// BUTTON VOTE
// ==========================================

function voteButtons(voteId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}on:${voteId}`)
        .setLabel('Điểm danh')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`${PREFIX}off:${voteId}`)
        .setLabel('Off')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`${PREFIX}late:${voteId}`)
        .setLabel('Onl muộn')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`${PREFIX}swap:${voteId}`)
        .setLabel('Swap Team')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ==========================================
// GIAO DIEN BANG VOTE
// ==========================================

function renderVote(vote, entries) {
  const team1 = teamMembers(entries, '1');
  const team2 = teamMembers(entries, '2');

  const lateCount = entries.filter(
    entry => entry.status === 'LATE'
  ).length;

  const offList = entries
    .filter(entry => entry.status === 'OFF')
    .slice(-10)
    .map(entry => `<@${entry.userId}>`)
    .join(', ');

  const embed = new EmbedBuilder()
    .setColor(0x6387bc)
    .setTitle(
      `🏯 ${vote.dungeonName}`.slice(0, 256)
    )
    .setDescription(
      '**BÁO DANH PHÓ BẢN 12 NGƯỜI**\n\n' +
      `⏰ **Thời gian:** ${vote.time}\n` +
      `👑 **Người tạo:** <@${vote.creatorId}>\n\n` +
      `📋 **Tổng báo danh:** ` +
      `**${team1.length + team2.length}/12**\n` +
      `🕒 **Onl muộn:** ${lateCount}`
    )
    .addFields(
      {
        name: `🔵 TEAM 1 (${team1.length}/6)`,
        value: formatTeam(entries, '1'),
        inline: true
      },
      {
        name: `🔴 TEAM 2 (${team2.length}/6)`,
        value: formatTeam(entries, '2'),
        inline: true
      }
    )
    .setFooter({
      text:
        'Mỗi team tối đa 6 người. ' +
        'Có thể Swap Team khi team còn lại còn chỗ.'
    });

  if (offList) {
    embed.addFields({
      name: '❌ Thành viên Off',
      value: offList.slice(0, 1000),
      inline: false
    });
  }

  return {
    embeds: [embed],
    components: voteButtons(vote.id),
    allowedMentions: {
      parse: []
    }
  };
}

// ==========================================
// QUYEN TAO VOTE
// ==========================================

function canCreate(interaction) {
  return require('../utils/bongPermission')
    .isBong(interaction);
}

// ==========================================
// FORM TAO VOTE
// ==========================================

function createVoteModal() {
  const dungeonInput = new TextInputBuilder()
    .setCustomId('dungeon')
    .setLabel('Tên phó bản')
    .setPlaceholder('Ví dụ: Thiên Cơ Mê Thành')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  const timeInput = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Thời gian')
    .setPlaceholder('Ví dụ: 20:30 ngày 13/11')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${PREFIX}create`)
    .setTitle('Tạo vote phó bản 12 người')
    .addComponents(
      new ActionRowBuilder().addComponents(dungeonInput),
      new ActionRowBuilder().addComponents(timeInput)
    );
}

async function handleSlashCommand(interaction) {
  if (!canCreate(interaction)) {
    return interaction.reply({
      content: 'Bạn không có quyền tạo vote phó bản.',
      ...EPHEMERAL
    });
  }

  // Chi mo form, CHUA dang bang vote.
  await interaction.showModal(createVoteModal());
}

// ==========================================
// XAC NHAN TAO VOTE
// ==========================================

async function handleCreateModal(interaction) {
  if (!canCreate(interaction)) {
    return interaction.reply({
      content: 'Bạn không có quyền tạo vote.',
      ...EPHEMERAL
    });
  }

  const dungeonName = cleanInput(
    interaction.fields.getTextInputValue('dungeon')
  );

  const time = cleanInput(
    interaction.fields.getTextInputValue('time')
  );

  if (!dungeonName || !time) {
    return interaction.reply({
      content:
        'Vui lòng nhập tên phó bản và thời gian.',
      ...EPHEMERAL
    });
  }

  await interaction.deferReply(EPHEMERAL);

  // Người đang Timeout không thể thao tác vote.
  const member = await interaction.guild.members.fetch({
    user: interaction.user.id,
    force: true
  });

  const restricted =
    member.roles.cache.has('1570679562873077852') ||
    (member.communicationDisabledUntilTimestamp || 0) >
      Date.now();

  if (restricted) {
    return interaction.editReply({
      content:
        '⛔ Bạn đang bị Timeout.\n' +
        'Trong thời gian này bạn không thể ' +
        'Điểm danh, Off, Onl muộn hoặc Swap Team.',
      components: []
    });
  }

  const vote = {
    id: interaction.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: '',
    dungeonName,
    time,
    creatorId: interaction.user.id,
    createdAt: new Date().toISOString(),
    status: 'OPEN'
  };

  let sentMessage;

  try {
    const api = await getApi();

    // Dang bang vote trong kenh hien tai.
    sentMessage = await interaction.channel.send(
      renderVote(vote, [])
    );

    vote.messageId = sentMessage.id;

    // Luu ten pho ban vao cot I.
    await appendRow(
      api,
      'Phoban12_Votes',
      [
        vote.id,
        vote.guildId,
        vote.channelId,
        vote.messageId,
        vote.time,
        vote.creatorId,
        vote.createdAt,
        vote.status,
        vote.dungeonName
      ]
    );

    await interaction.editReply({
      content:
        `✅ Đã tạo vote **${dungeonName}**!\n` +
        `⏰ ${time}\n` +
        `📌 ${sentMessage.url}`
    });
  } catch (error) {
    if (sentMessage) {
      await sentMessage.delete().catch(() => {});
    }

    throw error;
  }
}

// ==========================================
// CAP NHAT BANG VOTE DISCORD
// ==========================================

async function updatePanel(vote, entries) {
  const channel = await client.channels.fetch(
    vote.channelId
  );

  if (!channel?.messages?.fetch) {
    throw new Error(
      'Không tìm thấy kênh chứa bảng vote'
    );
  }

  const message = await channel.messages.fetch(
    vote.messageId
  );

  if (message.author.id !== client.user.id) {
    throw new Error(
      'Bảng vote không thuộc Monaris'
    );
  }

  await message.edit(
    renderVote(vote, entries)
  );
}

// ==========================================
// XU LY DIEM DANH / OFF / ONL MUON / SWAP
// ==========================================

async function changeRegistration(
  voteId,
  interaction,
  status,
  selectedClass = null
) {
  return withVoteLock(voteId, async () => {
    const api = await getApi();
    const vote = await findVote(api, voteId);

    if (!vote || vote.status !== 'OPEN') {
      return {
        message:
          '❌ Bảng vote không tồn tại hoặc đã đóng.'
      };
    }

    if (vote.guildId !== interaction.guildId) {
      return {
        message:
          '❌ Bảng vote không thuộc server này.'
      };
    }

    const entries = await loadEntries(api, voteId);
    const userId = interaction.user.id;

    const existing = entries.find(
      entry => entry.userId === userId
    );

    // =====================================
    // 1. SWAP TEAM
    // =====================================

    if (status === 'SWAP') {
      if (!existing || !active(existing)) {
        return {
          message:
            '❌ Bạn chưa báo danh vào team nào.'
        };
      }

      if (!['1', '2'].includes(existing.team)) {
        return {
          message:
            '❌ Không xác định được team hiện tại.'
        };
      }

      const currentTeam = existing.team;

      const targetTeam =
        currentTeam === '1' ? '2' : '1';

      const targetMembers = teamMembers(
        entries,
        targetTeam
      );

      if (targetMembers.length >= 6) {
        return {
          message:
            `❌ Team ${targetTeam} đã đủ 6 người.\n` +
            'Bạn chưa thể Swap Team.'
        };
      }

      existing.team = targetTeam;
      existing.sequence = Date.now();
      existing.updatedAt = new Date().toISOString();

      // Luu Team moi vao Google Sheets.
      await updateEntry(api, existing);

      // Cap nhat lai 2 team tren Discord.
      await updatePanel(vote, entries);

      return {
        message:
          '✅ **Swap Team thành công!**\n' +
          `🔄 Team ${currentTeam} → Team ${targetTeam}\n` +
          `⚔️ Môn phái: ${existing.className}\n` +
          `📌 Trạng thái: ${
            existing.status === 'LATE'
              ? 'Onl muộn'
              : 'Điểm danh'
          }`
      };
    }

    // =====================================
    // 2. OFF
    // =====================================

    if (status === 'OFF') {
      if (!existing || existing.status === 'OFF') {
        return {
          message:
            '❌ Bạn chưa có suất báo danh.'
        };
      }

      existing.status = 'OFF';
      existing.team = '';
      existing.updatedAt = new Date().toISOString();

      await updateEntry(api, existing);
      await updatePanel(vote, entries);

      return {
        message:
          '✅ Đã chuyển sang **Off**.\n' +
          'Suất trong team đã được giải phóng.'
      };
    }

    // =====================================
    // 3. DA BAO DANH, CHI DOI TRANG THAI
    // =====================================

    if (existing && active(existing)) {
      if (existing.status === status) {
        return {
          message:
            `Bạn đã báo danh Team ${existing.team} rồi.`
        };
      }

      existing.status = status;
      existing.updatedAt = new Date().toISOString();

      // Giu nguyen Team khi doi ON <-> LATE.
      await updateEntry(api, existing);
      await updatePanel(vote, entries);

      return {
        message:
          `✅ Đã cập nhật trạng thái tại ` +
          `**Team ${existing.team}**.\n` +
          (
            status === 'LATE'
              ? '🕒 Onl muộn — vẫn giữ chỗ.'
              : '✅ Điểm danh bình thường.'
          )
      };
    }

    // =====================================
    // 4. DANG KY MOI
    // =====================================

    let profile;

    if (selectedClass) {
      if (!CLASSES.includes(selectedClass)) {
        return {
          message:
            '❌ Môn phái không hợp lệ.'
        };
      }

      profile = {
        name: '',
        className: selectedClass
      };
    } else {
      profile = await getCharacterProfile(
        api,
        userId
      );
    }

    // Chua co ho so -> hoi mon phai.
    if (!profile?.className) {
      return {
        needClass: true,
        status
      };
    }

    // Khong con gioi han To Van / Thiet Y.
    const team = findAvailableTeam(entries);

    if (!team) {
      return {
        message:
          '❌ Cả Team 1 và Team 2 đều đã đủ 6 người.\n' +
          'Hiện chưa còn suất báo danh.'
      };
    }

    const record = {
      rowNumber: existing?.rowNumber || null,
      voteId,
      userId,
      userName: cleanInput(
        interaction.member?.displayName ||
        interaction.user.username
      ),
      characterName: profile.name,
      className: profile.className,
      status,
      team,
      updatedAt: new Date().toISOString(),
      sequence: Date.now()
    };

    if (existing) {
      // Nguoi da Off nay dang ky lai.
      await updateEntry(api, record);
      Object.assign(existing, record);
    } else {
      // Nguoi bao danh lan dau.
      await appendRow(
        api,
        'Phoban12_Entries',
        entryValues(record)
      );

      entries.push(record);
    }

    await updatePanel(vote, entries);

    return {
      message:
        '✅ **Báo danh thành công!**\n' +
        `🔵 Team: **${team}**\n` +
        `⚔️ Môn phái: **${record.className}**\n` +
        (
          status === 'LATE'
            ? '🕒 Trạng thái: Onl muộn'
            : '✅ Trạng thái: Điểm danh'
        )
    };
  });
}

// ==========================================
// CHON MON PHAI NEU CHUA CO HO SO
// ==========================================

function classPicker(voteId, status) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          `${PREFIX}pick:${voteId}:${status}`
        )
        .setPlaceholder('Chọn môn phái của bạn')
        .addOptions(
          CLASSES.map(name => ({
            label: name,
            value: name
          }))
        )
    )
  ];
}

// ==========================================
// XU LY NUT BAM
// ==========================================

async function handleRegistration(interaction) {
  const parts = interaction.customId.split(':');

  const operation = parts[1];
  const voteId = parts[2];

  if (!voteId) return;

  await interaction.deferReply(EPHEMERAL);

  let status;
  let selectedClass = null;

  if (operation === 'pick') {
    status = parts[3];
    selectedClass = interaction.values?.[0];

    if (!['ON', 'LATE'].includes(status)) {
      return interaction.editReply(
        '❌ Trạng thái không hợp lệ.'
      );
    }
  } else {
    status =
      operation === 'on' ? 'ON' :
      operation === 'late' ? 'LATE' :
      operation === 'swap' ? 'SWAP' :
      operation === 'off' ? 'OFF' :
      null;
  }

  if (!status) {
    return interaction.editReply(
      '❌ Thao tác không hợp lệ.'
    );
  }

  const result = await changeRegistration(
    voteId,
    interaction,
    status,
    selectedClass
  );

  if (result.needClass) {
    return interaction.editReply({
      content:
        '⚔️ Bạn chưa có môn phái trong hồ sơ nhân vật.\n' +
        'Hãy chọn môn phái để Monaris xếp đội:',
      components: classPicker(
        voteId,
        result.status
      )
    });
  }

  await interaction.editReply({
    content: result.message,
    components: []
  });
}

// ==========================================
// DISCORD INTERACTIONS
// ==========================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    if (!interaction.inGuild()) return;
    if (interaction.guildId !== GUILD_ID) return;

    const isSlash =
      interaction.isChatInputCommand() &&
      interaction.commandName === 'phoban12';

    const isCreateModal =
      interaction.isModalSubmit() &&
      interaction.customId === `${PREFIX}create`;

    const isRegistration =
      (
        interaction.isButton() ||
        interaction.isStringSelectMenu()
      ) &&
      interaction.customId?.startsWith(PREFIX) &&
      [
        'on',
        'off',
        'late',
        'swap',
        'pick'
      ].includes(
        interaction.customId.split(':')[1]
      );

    if (
      !isSlash &&
      !isCreateModal &&
      !isRegistration
    ) {
      return;
    }

    try {
      if (isSlash) {
        await handleSlashCommand(interaction);
      } else if (isCreateModal) {
        await handleCreateModal(interaction);
      } else {
        await handleRegistration(interaction);
      }
    } catch (error) {
      console.error('[Phoban12]', error);

      const payload = {
        content:
          '❌ Monaris không thể xử lý vote.\n' +
          'Vui lòng kiểm tra log [Phoban12] trong CMD.',
        components: []
      };

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.editReply(payload)
          .catch(() => {});
      } else {
        await interaction.reply({
          ...payload,
          ...EPHEMERAL
        }).catch(() => {});
      }
    }
  }
);

// ==========================================
// EXPORT
// ==========================================

module.exports = {
  PHOBAN12_SLASH_COMMANDS,
  findAvailableTeam,
  renderVote,
  createVoteModal
};

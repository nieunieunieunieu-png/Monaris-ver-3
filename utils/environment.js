const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function loadEnvironment(file = path.join(ROOT, '.env')) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
  // Existing time helpers shift UTC to Vietnam and then use local getters.
  process.env.TZ = 'UTC';
}
function validateEnvironment(env = process.env) {
  const errors = [], warnings = [];
  for (const name of ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'ADMIN_USER_ID', 'GOOGLE_SHEET_ID']) {
    if (!env[name]?.trim() || /^(DIEN_|YOUR_|REPLACE_|CHANGEME)/i.test(env[name])) errors.push(`Chưa điền ${name}.`);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^(?:DISCORD_GUILD_ID|ADMIN_USER_ID|BOT_CREATOR_DISCORD_ID|.*_CHANNEL_ID|.*_ROLE_ID|WELCOME_GUILD_ID)$/.test(name)) continue;
    if (value === 'off' && ['LEVEL_TOP_ROLE_ID', 'LEVEL_MONTH_ROLE_ID'].includes(name)) continue;
    if (!/^\d{17,20}$/.test(value)) errors.push(`${name} phải là Discord ID gồm 17–20 chữ số.`);
  }
  let credentials;
  if (env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    try { credentials = JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')); }
    catch { try { credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_BASE64); } catch { errors.push('GOOGLE_SERVICE_ACCOUNT_BASE64 không phải credentials JSON/base64 hợp lệ.'); } }
  } else if (env.GOOGLE_SERVICE_ACCOUNT_FILE || env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentialPath = env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(credentialPath)) {
      errors.push('Đường dẫn Google credentials Windows không dùng được trên Render/Linux. Đặt GOOGLE_SERVICE_ACCOUNT_BASE64 trong Environment.');
    } else {
      try { credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8')); }
      catch { errors.push('Không đọc được file Google credentials trên server. Trên Render hãy dùng GOOGLE_SERVICE_ACCOUNT_BASE64.'); }
    }
  } else errors.push('Cần GOOGLE_SERVICE_ACCOUNT_BASE64 hoặc file credentials Google tồn tại trên server.');
  if (credentials && (!credentials.client_email || !credentials.private_key)) errors.push('Credentials Google thiếu client_email hoặc private_key.');
  if (!env.GEMINI_API_KEY) warnings.push('Chưa có GEMINI_API_KEY: AI và dịch chưa hoạt động.');
  if (!env.CONG_DUC_CHANNEL_ID) warnings.push('Chưa chọn kênh Sảnh Công Đức.');
  if (!env.TEMP_VOICE_LOBBY_CHANNEL_ID) warnings.push('Chưa chọn kênh cổng voice tạm.');
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) warnings.push('Chưa đủ Cloudinary: chức năng upload ảnh chưa sẵn sàng.');
  if (env.PORT && (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535)) errors.push('PORT phải từ 1 đến 65535.');
  return { errors, warnings };
}
module.exports = { ROOT, loadEnvironment, validateEnvironment };

const { google } = require('./googleClient');
const fs = require('node:fs');
const path = require('node:path');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

// Dùng chung 1 client cho toàn bộ bot (hơn 60 chỗ gọi hàm này). Trước đây mỗi lần gọi lại giải mã credentials,
// tạo GoogleAuth mới và xin token mới -> tốn RAM/CPU/mạng và làm log rối. GoogleAuth tự làm mới token khi hết hạn.
let cachedClient = null;
let pending = null; // đang khởi tạo -> các lần gọi đồng thời chờ chung 1 kết quả

function parseCredentials(raw) {
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (decodeError) {
    try {
      return JSON.parse(raw); // phòng trường hợp ENV dán thẳng JSON
    } catch (jsonError) {
      throw decodeError;
    }
  }
}

async function createClient() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    const credentials = parseCredentials(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64);
    console.log('Google auth: dùng credentials từ GOOGLE_SERVICE_ACCOUNT_BASE64.');
    return new google.auth.GoogleAuth({ credentials, scopes: SCOPES }).getClient();
  }

  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!credentialPath) {
    console.warn('[Google auth] Thiếu credentials. Trên Render: đặt GOOGLE_SERVICE_ACCOUNT_BASE64 (không commit JSON vào GitHub).');
    return null;
  }

  // Render runs Linux: Windows paths from a local .env cannot exist here.
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(credentialPath)) {
    throw new Error('Render/Linux không đọc được đường dẫn Google JSON trên Windows. Đặt GOOGLE_SERVICE_ACCOUNT_BASE64 trên Render và xóa GOOGLE_SERVICE_ACCOUNT_FILE / GOOGLE_APPLICATION_CREDENTIALS đang trỏ đến E:/Monaris.');
  }

  const resolvedPath = path.resolve(credentialPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('Không tìm thấy file Google credentials trên server. Với Render, hãy đặt GOOGLE_SERVICE_ACCOUNT_BASE64 trong Environment; không dùng đường dẫn từ PC.');
  }
  console.log('Google auth: dùng credentials từ file trên máy chủ.');
  return new google.auth.GoogleAuth({ keyFile: resolvedPath, scopes: SCOPES }).getClient();
}

async function getGoogleAuthClient() {
  if (cachedClient) return cachedClient;
  if (!pending) {
    pending = createClient()
      .then((client) => {
        cachedClient = client; // null (chưa cấu hình) thì không nhớ, lần sau thử lại
        return client;
      })
      .catch((error) => {
        console.error('Failed to initialize Google Sheets auth:', error.message);
        return null;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

module.exports = { getGoogleAuthClient };

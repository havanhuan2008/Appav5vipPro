import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const LINK4M_API_TOKEN = process.env.LINK4M_API_TOKEN || '';
const FREE_KEY_TTL_HOURS = Number(process.env.FREE_KEY_TTL_HOURS || 5);
const VERIFY_SESSION_MINUTES = Number(process.env.VERIFY_SESSION_MINUTES || 30);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change_this_admin_token_32_chars_min';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TGBOT_LOGIN_PASSWORD = process.env.TGBOT_LOGIN_PASSWORD || 'BotLogin123!';
const TG_ADMIN_IDS = (process.env.TG_ADMIN_IDS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const STORE_PATH = path.join(__dirname, 'data', 'store.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return Date.now();
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.keys ||= {};
    parsed.freeKeySessions ||= {};
    parsed.notifications ||= [];
    parsed.adminSessions ||= {};
    parsed.botSessions ||= {};
    parsed.botOffset ||= 0;
    return parsed;
  } catch {
    return {
      keys: {},
      freeKeySessions: {},
      notifications: [],
      adminSessions: {},
      botSessions: {},
      botOffset: 0
    };
  }
}

let store = readStore();

function writeStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function randomHex(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

function randomKey(prefix = 'VIP') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}-${part(4)}-${part(4)}-${part(4)}`;
}

function requireAdmin(req, res, next) {
  const sessionToken = req.headers['x-admin-session'];
  if (!sessionToken) {
    return res.status(401).json({ ok: false, message: 'Thiếu phiên admin.' });
  }
  const session = store.adminSessions[sessionToken];
  if (!session || session.expiresAt < now()) {
    delete store.adminSessions[sessionToken];
    writeStore();
    return res.status(401).json({ ok: false, message: 'Phiên admin đã hết hạn.' });
  }
  req.adminSession = session;
  next();
}

function cleanExpiredData() {
  const t = now();

  for (const [token, session] of Object.entries(store.adminSessions)) {
    if (!session || session.expiresAt < t) delete store.adminSessions[token];
  }

  for (const [rid, session] of Object.entries(store.freeKeySessions)) {
    if (!session || session.expiresAt < t) delete store.freeKeySessions[rid];
  }

  for (const [key, keyData] of Object.entries(store.keys)) {
    if (!keyData) {
      delete store.keys[key];
      continue;
    }
    if (keyData.expiresAt && keyData.expiresAt < t && keyData.type === 'free') {
      keyData.active = false;
    }
  }

  writeStore();
}

setInterval(cleanExpiredData, 60_000);
cleanExpiredData();

function sanitizeKeyRecord(key, keyData) {
  return {
    key,
    type: keyData.type || 'manual',
    active: keyData.active !== false,
    createdAt: keyData.createdAt || null,
    expiresAt: keyData.expiresAt || null,
    maxDevices: keyData.maxDevices || 1,
    note: keyData.note || '',
    issuedForDeviceId: keyData.issuedForDeviceId || null,
    deviceCount: Object.keys(keyData.devices || {}).length,
    devices: keyData.devices || {}
  };
}

function validateKeyForDevice(key, deviceId, options = {}) {
  const keyData = store.keys[key];
  if (!keyData) throw new Error('Key không tồn tại.');
  if (keyData.active === false) throw new Error('Key đã bị vô hiệu hóa.');
  if (keyData.expiresAt && keyData.expiresAt < now()) throw new Error('Key đã hết hạn.');
  if (!deviceId) throw new Error('Thiếu deviceId.');

  keyData.devices ||= {};
  const deviceCount = Object.keys(keyData.devices).length;
  const alreadyBound = !!keyData.devices[deviceId];

  if (keyData.issuedForDeviceId && keyData.issuedForDeviceId !== deviceId) {
    throw new Error('Key này chỉ dùng trên thiết bị đã được cấp.');
  }

  const maxDevices = Number(keyData.maxDevices || 1);
  if (!alreadyBound && deviceCount >= maxDevices) {
    throw new Error(`Key đã đạt giới hạn ${maxDevices} thiết bị.`);
  }

  if (options.bindDevice !== false) {
    const firstLogin = alreadyBound ? keyData.devices[deviceId].firstLogin || now() : now();
    keyData.devices[deviceId] = {
      firstLogin,
      lastLogin: now(),
      userAgent: options.userAgent || keyData.devices[deviceId]?.userAgent || ''
    };
    writeStore();
  }

  return keyData;
}

function findActiveFreeKeyForDevice(deviceId) {
  return Object.entries(store.keys).find(([, keyData]) => {
    return (
      keyData &&
      keyData.type === 'free' &&
      keyData.active !== false &&
      keyData.issuedForDeviceId === deviceId &&
      (!keyData.expiresAt || keyData.expiresAt > now())
    );
  });
}

function createNotification({ title, message, type = 'info' }) {
  const notification = {
    id: `notif_${randomHex(6)}`,
    title: title || 'Thông báo',
    message: message || '',
    type,
    createdAt: now()
  };
  store.notifications.unshift(notification);
  store.notifications = store.notifications.slice(0, 100);
  writeStore();
  return notification;
}

async function createLink4mShortLink(destinationUrl) {
  if (!LINK4M_API_TOKEN) {
    return { shortUrl: destinationUrl, via: 'direct' };
  }

  const apiUrl = new URL('https://link4m.co/api-shorten/v2');
  apiUrl.searchParams.set('api', LINK4M_API_TOKEN);
  apiUrl.searchParams.set('url', destinationUrl);

  const response = await fetch(apiUrl.toString(), { method: 'GET' });
  const result = await response.json();

  if (result.status !== 'success' || !result.shortenedUrl) {
    throw new Error(result.message || 'Không tạo được short-link Link4m.');
  }

  return { shortUrl: result.shortenedUrl, via: 'link4m' };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: now(), baseUrl: APP_BASE_URL });
});

app.get('/api/public/notifications', (_req, res) => {
  res.json({ ok: true, notifications: store.notifications.slice(0, 30) });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { key, deviceId, userAgent = '' } = req.body || {};
    if (!key) throw new Error('Vui lòng nhập key.');
    const keyData = validateKeyForDevice(key.trim(), deviceId, { bindDevice: true, userAgent });
    return res.json({ ok: true, keyData: sanitizeKeyRecord(key.trim(), keyData) });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/status', (req, res) => {
  try {
    const { key, deviceId } = req.body || {};
    if (!key) throw new Error('Thiếu key.');
    const keyData = validateKeyForDevice(key.trim(), deviceId, { bindDevice: false });
    return res.json({ ok: true, keyData: sanitizeKeyRecord(key.trim(), keyData) });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/free-key/create-link', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) throw new Error('Thiếu deviceId.');

    const rid = crypto.randomUUID();
    const state = randomHex(16);
    const expiresAt = now() + VERIFY_SESSION_MINUTES * 60 * 1000;
    const verifyUrl = `${APP_BASE_URL}/verify?rid=${encodeURIComponent(rid)}&state=${encodeURIComponent(state)}`;

    store.freeKeySessions[rid] = {
      rid,
      state,
      deviceId,
      createdAt: now(),
      expiresAt,
      verified: false,
      claimed: false
    };
    writeStore();

    const { shortUrl, via } = await createLink4mShortLink(verifyUrl);
    store.freeKeySessions[rid].shortUrl = shortUrl;
    writeStore();

    res.json({ ok: true, rid, shortUrl, expiresAt, via });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/verify', (req, res) => {
  const { rid, state } = req.query || {};
  const session = store.freeKeySessions[rid];
  if (!session || session.expiresAt < now() || session.state !== state) {
    return res.status(400).send('Phiên xác minh không hợp lệ hoặc đã hết hạn.');
  }
  session.verified = true;
  writeStore();
  return res.redirect(`${APP_BASE_URL}/free-key.html?rid=${encodeURIComponent(rid)}&verified=1`);
});

app.post('/api/free-key/claim', (req, res) => {
  try {
    const { rid, deviceId, userAgent = '' } = req.body || {};
    if (!rid || !deviceId) throw new Error('Thiếu rid hoặc deviceId.');
    const session = store.freeKeySessions[rid];
    if (!session) throw new Error('Phiên không tồn tại.');
    if (session.expiresAt < now()) throw new Error('Phiên đã hết hạn.');
    if (!session.verified) throw new Error('Bạn chưa hoàn tất bước xác minh.');
    if (session.deviceId !== deviceId) throw new Error('Phiên này không thuộc thiết bị hiện tại.');

    const existing = findActiveFreeKeyForDevice(deviceId);
    if (existing) {
      const [existingKey, existingData] = existing;
      session.claimed = true;
      writeStore();
      return res.json({ ok: true, reused: true, key: existingKey, keyData: sanitizeKeyRecord(existingKey, existingData) });
    }

    const key = randomKey('FREE');
    const expiresAt = now() + FREE_KEY_TTL_HOURS * 60 * 60 * 1000;
    store.keys[key] = {
      type: 'free',
      active: true,
      createdAt: now(),
      expiresAt,
      maxDevices: 1,
      note: 'Key free theo thiết bị',
      issuedForDeviceId: deviceId,
      devices: {},
      claimMeta: {
        rid,
        claimedAt: now(),
        userAgent
      }
    };
    session.claimed = true;
    writeStore();

    createNotification({
      title: 'Đã cấp key free mới',
      message: `Thiết bị ${deviceId.slice(0, 10)}... đã nhận key free 5 giờ.`,
      type: 'success'
    });

    return res.json({ ok: true, reused: false, key, keyData: sanitizeKeyRecord(key, store.keys[key]) });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username = '', password = '', token = '' } = req.body || {};
  const validByToken = token && token === ADMIN_TOKEN;
  const validByUserPass = username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
  if (!validByToken && !validByUserPass) {
    return res.status(401).json({ ok: false, message: 'Thông tin admin không hợp lệ.' });
  }
  const sessionToken = randomHex(24);
  store.adminSessions[sessionToken] = {
    createdAt: now(),
    expiresAt: now() + 12 * 60 * 60 * 1000,
    username: ADMIN_USERNAME
  };
  writeStore();
  return res.json({ ok: true, sessionToken, username: ADMIN_USERNAME });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const keys = Object.entries(store.keys).map(([key, keyData]) => sanitizeKeyRecord(key, keyData));
  const activeKeys = keys.filter(k => k.active && (!k.expiresAt || k.expiresAt > now()));
  const devices = [];
  keys.forEach(k => {
    Object.entries(k.devices || {}).forEach(([deviceId, data]) => {
      devices.push({
        key: k.key,
        deviceId,
        firstLogin: data.firstLogin || null,
        lastLogin: data.lastLogin || null,
        userAgent: data.userAgent || ''
      });
    });
  });
  res.json({
    ok: true,
    totals: {
      keys: keys.length,
      activeKeys: activeKeys.length,
      freeKeys: keys.filter(k => k.type === 'free').length,
      devices: devices.length,
      notifications: store.notifications.length
    },
    keys: keys.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100),
    devices: devices.sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0)).slice(0, 200),
    notifications: store.notifications.slice(0, 30)
  });
});

app.post('/api/admin/create-key', requireAdmin, (req, res) => {
  try {
    const {
      prefix = 'VIP',
      hours = 24,
      maxDevices = 1,
      note = '',
      permanent = false
    } = req.body || {};

    const key = randomKey(prefix.toUpperCase().slice(0, 8) || 'VIP');
    store.keys[key] = {
      type: 'manual',
      active: true,
      createdAt: now(),
      expiresAt: permanent ? null : now() + Number(hours) * 60 * 60 * 1000,
      maxDevices: Number(maxDevices) || 1,
      note,
      devices: {}
    };
    writeStore();

    createNotification({
      title: 'Admin đã tạo key mới',
      message: `${key} đã được tạo từ bảng quản trị.`,
      type: 'info'
    });

    res.json({ ok: true, key, keyData: sanitizeKeyRecord(key, store.keys[key]) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/toggle-key', requireAdmin, (req, res) => {
  try {
    const { key, active } = req.body || {};
    if (!key || !store.keys[key]) throw new Error('Key không tồn tại.');
    store.keys[key].active = !!active;
    writeStore();
    createNotification({
      title: active ? 'Key đã được mở lại' : 'Key đã bị khóa',
      message: `${key} ${active ? 'được kích hoạt lại' : 'đã bị vô hiệu hóa'} từ admin.`,
      type: active ? 'success' : 'warn'
    });
    res.json({ ok: true, keyData: sanitizeKeyRecord(key, store.keys[key]) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/unbind-device', requireAdmin, (req, res) => {
  try {
    const { key, deviceId } = req.body || {};
    if (!key || !deviceId || !store.keys[key]) throw new Error('Thiếu key hoặc deviceId.');
    delete store.keys[key].devices?.[deviceId];
    writeStore();
    res.json({ ok: true, keyData: sanitizeKeyRecord(key, store.keys[key]) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/notify', requireAdmin, (req, res) => {
  try {
    const { title, message, type = 'info' } = req.body || {};
    if (!title || !message) throw new Error('Thiếu tiêu đề hoặc nội dung.');
    const notification = createNotification({ title, message, type });
    res.json({ ok: true, notification });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/free-key', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'free-key.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/free-key.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'free-key.html')));
app.get('/admin.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((req, res) => {
  res.status(404).send('Not Found');
});

async function telegramApi(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return response.json();
}

function botIsAllowed(userId) {
  return TG_ADMIN_IDS.includes(String(userId));
}

function botIsLoggedIn(chatId) {
  const session = store.botSessions[String(chatId)];
  return !!session && session.expiresAt > now();
}

async function botReply(chatId, text) {
  await telegramApi('sendMessage', { chat_id: chatId, text });
}

async function handleBotCommand(message) {
  if (!message || !message.chat || !message.text) return;
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text.trim();

  if (!botIsAllowed(userId)) {
    await botReply(chatId, 'Bạn không có quyền dùng bot này.');
    return;
  }

  const [command, ...rest] = text.split(' ');

  if (command === '/start') {
    await botReply(chatId, 'Bot quản trị đã sẵn sàng. Dùng /login <mật_khẩu> để bắt đầu.');
    return;
  }

  if (command === '/login') {
    const pass = rest.join(' ').trim();
    if (!pass || pass !== TGBOT_LOGIN_PASSWORD) {
      await botReply(chatId, 'Mật khẩu bot không đúng.');
      return;
    }
    store.botSessions[String(chatId)] = {
      userId: String(userId),
      loginAt: now(),
      expiresAt: now() + 12 * 60 * 60 * 1000
    };
    writeStore();
    await botReply(chatId, 'Đăng nhập bot thành công. Bạn có thể dùng /taokey và /quanlithietbi.');
    return;
  }

  if (!botIsLoggedIn(chatId)) {
    await botReply(chatId, 'Bạn cần /login trước khi dùng lệnh quản trị.');
    return;
  }

  if (command === '/logout') {
    delete store.botSessions[String(chatId)];
    writeStore();
    await botReply(chatId, 'Đã đăng xuất bot.');
    return;
  }

  if (command === '/taokey') {
    const hours = Number(rest[0] || 24);
    const maxDevices = Number(rest[1] || 1);
    const note = rest.slice(2).join(' ') || 'Key tạo từ Telegram bot';
    const key = randomKey('BOT');
    store.keys[key] = {
      type: 'manual',
      active: true,
      createdAt: now(),
      expiresAt: now() + hours * 60 * 60 * 1000,
      maxDevices,
      note,
      devices: {}
    };
    writeStore();
    await botReply(chatId, `Đã tạo key mới:\n${key}\nHạn: ${hours} giờ\nThiết bị: ${maxDevices}`);
    return;
  }

  if (command === '/quanlithietbi') {
    const devices = [];
    Object.entries(store.keys).forEach(([key, keyData]) => {
      Object.entries(keyData.devices || {}).forEach(([deviceId, data]) => {
        devices.push(`${deviceId.slice(0, 12)}... | ${key} | ${new Date(data.lastLogin || now()).toLocaleString('vi-VN')}`);
      });
    });
    const out = devices.length ? devices.slice(0, 20).join('\n') : 'Chưa có thiết bị nào đăng nhập.';
    await botReply(chatId, `Danh sách thiết bị:\n${out}`);
    return;
  }

  if (command === '/xemkey') {
    const keys = Object.entries(store.keys)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
      .slice(0, 15)
      .map(([key, keyData]) => `${key} | ${keyData.active !== false ? 'ON' : 'OFF'} | ${keyData.type}`);
    await botReply(chatId, keys.length ? keys.join('\n') : 'Chưa có key nào.');
    return;
  }

  if (command === '/khoakey') {
    const key = rest[0];
    if (!key || !store.keys[key]) {
      await botReply(chatId, 'Không tìm thấy key để khóa.');
      return;
    }
    store.keys[key].active = false;
    writeStore();
    await botReply(chatId, `Đã khóa key ${key}.`);
    return;
  }

  if (command === '/mokey') {
    const key = rest[0];
    if (!key || !store.keys[key]) {
      await botReply(chatId, 'Không tìm thấy key để mở.');
      return;
    }
    store.keys[key].active = true;
    writeStore();
    await botReply(chatId, `Đã mở lại key ${key}.`);
    return;
  }

  if (command === '/thongbao') {
    const joined = rest.join(' ');
    const [title, message] = joined.split('|').map(v => v?.trim());
    if (!title || !message) {
      await botReply(chatId, 'Dùng: /thongbao Tiêu đề | Nội dung');
      return;
    }
    const notification = createNotification({ title, message, type: 'info' });
    await botReply(chatId, `Đã gửi thông báo: ${notification.title}`);
    return;
  }

  await botReply(chatId, 'Lệnh không hỗ trợ. Có thể dùng: /login, /taokey, /quanlithietbi, /xemkey, /khoakey, /mokey, /thongbao, /logout');
}

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const offset = Number(store.botOffset || 0);
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=20&offset=${offset}`);
    const data = await response.json();
    if (data.ok && Array.isArray(data.result) && data.result.length) {
      for (const update of data.result) {
        store.botOffset = update.update_id + 1;
        if (update.message) {
          await handleBotCommand(update.message);
        }
      }
      writeStore();
    }
  } catch (error) {
    console.error('Telegram polling error:', error.message);
  } finally {
    setTimeout(pollTelegram, 2000);
  }
}

if (TELEGRAM_BOT_TOKEN) {
  pollTelegram();
}

app.listen(PORT, () => {
  console.log(`SecureApp Pro V5 running at ${APP_BASE_URL}`);
});

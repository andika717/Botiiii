const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- konfigurasi folder data ---
const DB = path.resolve(__dirname, 'data');
if (!fs.existsSync(DB)) fs.mkdirSync(DB);

// --- file database ---
const USERS_DB = path.join(DB, 'users.json'); // { username: [ { id, cookie } ] }
const BLOCK_DB = path.join(DB, 'blocked.json'); // [ username, ... ]

function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file)); }
  catch { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
}
function save(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let users = load(USERS_DB, {}); // { username: [ { id, cookie } ] }
let blocked = load(BLOCK_DB, []); // [ username, ... ]

const TOKEN = '7560169402:AAEM51-xZB7loIUf3daGjYVp6JABf06cjpg';
const ADMIN_IDS = [7331090593,8127446208];
const bot = new TelegramBot(TOKEN, { polling: true });

// — Shopee headers untuk claim —
const H = {
  'Sec-Ch-Ua-Mobile':'?0',
  'X-Sz-Sdk-Version':'3.1.0-2&1.5.1',
  'User-Agent':'Mozilla/5.0',
  'Content-Type':'application/json',
  'X-Api-Source':'pc',
  'Accept':'application/json',
  'X-Shopee-Language':'id',
  'X-Requested-With':'XMLHttpRequest',
  'Referer':'https://shopee.co.id'
};

const sessions = new Map(); // chatId → timer data tmp
const adminState = new Map(); // not used here, placeholder

// --- menu utama ---
function mainMenu(isAdmin) {
  const btn = [
    [{ text:'🔑 Scan Akun', callback_data:'scan' }],
    [{ text:'📂 Akun Saya', callback_data:'my' }],
    [{ text:'❓ Bantuan', callback_data:'help' }],
    [{ text:'🗑️ Hapus Akun', callback_data:'del_acc'}],
  ];
  if (isAdmin) {
    btn.push(
      [{ text:'👥 Semua Akun', callback_data:'all' }],
      [{ text:'🔗 Klaim Voucher', callback_data:'claim_vc'}],
      [{ text:'🚫 Blokir Username', callback_data:'block' }],
      [{ text:'✅ Unblokir Username',callback_data:'unblock' }],
      [{ text:'📊 Statistik', callback_data:'stats' }],
      [{ text:'♻️ Reset Data', callback_data:'reset' }]
    );
  }
  return { reply_markup:{ inline_keyboard: btn } };
}
const back = { reply_markup:{ inline_keyboard:[
  [{ text:'🔙 Batal', callback_data:'cancel' }]
]}};

// --- parse Shopee QR & simpan cookie + username ---
async function startQR(chatId, username) {
  const res = await axios.get('https://shopee.co.id/api/v2/authentication/gen_qrcode',{ headers:H });
  const qr = res.data.data;
  sessions.set(chatId, { });
  await bot.sendPhoto(chatId, Buffer.from(qr.qrcode_base64,'base64'), {
    caption:'📱 *Scan QR* dalam 60 detik untuk simpan akun',
    parse_mode:'Markdown'
  });
  let t=0, iv=setInterval(async()=>{
    t++;
    if (t>60) {
      clearInterval(iv);
      sessions.delete(chatId);
      return bot.sendMessage(chatId,'⌛ QR expired.', mainMenu(false));
    }
    const st = await axios.get(
      `https://shopee.co.id/api/v2/authentication/qrcode_status?qrcode_id=${encodeURIComponent(qr.qrcode_id)}`,
      { headers:H }
    );
    if (st.data.data.status==='CONFIRMED') {
      clearInterval(iv);
      const ln = await axios.post(
        'https://shopee.co.id/api/v2/authentication/qrcode_login',
        { qrcode_token:st.data.data.qrcode_token,device_sz_fingerprint:'',client_identifier:{security_device_fingerprint:''} },
        { headers:H }
      );
      const cks = ln.headers['set-cookie']||[];
      const spc = cks.find(c=>c.startsWith('SPC_EC='))?.split(';')[0];
      if (!spc) return bot.sendMessage(chatId,'❌ Gagal ambil cookie.', mainMenu(false));
      // simpan entry
      const entry = { id: Date.now(), cookie: spc };
      users[username] = users[username]||[];
      users[username].push(entry);
      save(USERS_DB, users);
      sessions.delete(chatId);
      return bot.sendMessage(chatId,
        `✅ Akun [@${username}](tg://user?id=${chatId}) disimpan.`,
        { parse_mode:'Markdown', ...mainMenu(false) }
      );
    }
  },1000);
}

// --- klaim via cookie semua entry ---
async function doClaimAll(promo) {
  for (let uname in users) {
    for (let x of users[uname]) {
      await axios.post(
        'https://mall.shopee.co.id/api/v2/voucher_wallet/save_voucher',
        promo,
        { headers:{...H, Cookie:x.cookie} }
      );
    }
  }
}

// --- handler pesan biasa ---
bot.on('message', msg=>{
  const c = msg.chat.id, u = msg.from;
  if (!u.username) {
    return bot.sendMessage(c,'❌ Harus punya @username untuk pakai bot.');
  }
  if (blocked.includes(u.username) && !ADMIN_IDS.includes(u.id)) {
    return bot.sendMessage(c,'❌ Kamu diblokir.');
  }
  if (msg.text==='/start') {
    return bot.sendMessage(c,'👋 Selamat datang!', mainMenu(ADMIN_IDS.includes(u.id)));
  }
});

// --- inline callbacks ---
bot.on('callback_query', async q=>{
  const c = q.message.chat.id;
  const d = q.data;
  const u = q.from;
  const isAdm = ADMIN_IDS.includes(u.id);
  const uname = u.username;

  if (d==='cancel' || d==='main_menu') {
    sessions.delete(c);
    return bot.sendMessage(c,'🏠 Kembali ke menu', mainMenu(isAdm));
  }

  // Bantuan
  if (d==='help') {
    return bot.sendMessage(c,
      `📖 *Panduan*:\n`+
      `1️⃣ *Scan Akun* → simpan cookie\n`+
      `2️⃣ *Akun Saya* → lihat daftar akun\n`+
      `3️⃣ *Hapus Akun* → pilih untuk hapus\n\n`+
      `🤖 *Admin* punya menu tambahan.`,
      { parse_mode:'Markdown', ...back }
    );
  }

  // Scan akun
  if (d==='scan') return startQR(c, uname);

  // Akun saya
  if (d==='my') {
    const list = users[uname]||[];
    if (!list.length) return bot.sendMessage(c,'ℹ️ Belum ada akun tersimpan.', mainMenu(isAdm));
    let txt = '📂 *Akun Saya*:\n\n';
    list.forEach(x=> txt += `• ID:${x.id}\n`);
    return bot.sendMessage(c, txt, { parse_mode:'Markdown', ...mainMenu(isAdm) });
  }

  // Hapus Akun per entri
  if (d==='del_acc') {
    const list = users[uname]||[];
    if (!list.length) return bot.sendMessage(c,'ℹ️ Belum ada akun tersimpan.', mainMenu(isAdm));
    const kb = list.map(x=>[{ text:`ID:${x.id}`, callback_data:`del_${x.id}` }]);
    kb.push([{ text:'🔙 Batal', callback_data:'cancel' }]);
    return bot.sendMessage(c,'🗑️ Pilih ID untuk dihapus:', {
      reply_markup:{ inline_keyboard: kb }
    });
  }
  if (d.startsWith('del_')) {
    const id = +d.split('_')[1];
    users[uname] = (users[uname]||[]).filter(x=>x.id!==id);
    save(USERS_DB, users);
    return bot.sendMessage(c,'✅ Akun dihapus.', mainMenu(isAdm));
  }

  // Admin-only
  if (!isAdm) return bot.answerCallbackQuery(q.id,'❌ Hanya admin.', true);

  // Semua akun
  if (d==='all') {
    let txt = '👥 *Semua Akun*:\n\n';
    for (let usernm in users) {
      txt += `@${usernm}:\n`;
      users[usernm].forEach(x=> txt += ` • ID:${x.id}\n`);
    }
    return bot.sendMessage(c, txt, { parse_mode:'Markdown', ...mainMenu(true) });
  }

  // Blokir / Unblokir username
  if (d==='block' || d==='unblock') {
    return bot.sendMessage(c,
      `🔒 Kirim /${d} <username>`,
      back
    );
  }

  // Statistik
  if (d==='stats') {
    const totalUser = Object.keys(users).length;
    const totalAcc = Object.values(users).reduce((a,arr)=>a+arr.length,0);
    let txt = `📊 Statistik bot\n`+
              `Total akun telegram: ${totalUser}\n`+
              `Total seluruh akun tersetor: ${totalAcc}\n\n`+
              `*Statistik klaim:*\n`;
    Object.keys(users).forEach(u0=>{
      const cnt = users[u0].length;
      txt += `@${u0} : ${cnt} akun = ${cnt} klaim\n`;
    });
    return bot.sendMessage(c, txt, { parse_mode:'Markdown', ...mainMenu(true) });
  }

  // Klaim voucher via admin
  if (d==='claim_vc') {
    return bot.sendMessage(c,
      '🔗 Kirim link voucher Shopee (promotionId & signature) untuk klaim:',
      back
    );
  }

  // Reset semua data
  if (d==='reset') {
    users = {}; save(USERS_DB, users);
    blocked = []; save(BLOCK_DB, blocked);
    return bot.sendMessage(c,'♻️ Semua data telah di-reset.', mainMenu(true));
  }
});

// block/unblock via command
bot.onText(/\/block\s+@?(\w+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const u0 = match[1];
  if (!blocked.includes(u0)) {
    blocked.push(u0);
    save(BLOCK_DB, blocked);
  }
  bot.sendMessage(msg.chat.id, `🚫 @${u0} diblokir.`);
});
bot.onText(/\/unblock\s+@?(\w+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const u0 = match[1];
  blocked = blocked.filter(u=>u!==u0);
  save(BLOCK_DB, blocked);
  bot.sendMessage(msg.chat.id, `✅ @${u0} dibuka blokir.`);
});

// admin kirim link voucher → klaim semua cookie
bot.on('message', async msg => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const t = msg.text||'';
  if (!t.includes('promotionId')||!t.includes('signature')) return;
  const m = t.match(/promotionId=(\d+).*signature=([0-9a-f]+)/);
  if (!m) return bot.sendMessage(msg.chat.id,'❌ Format salah.');
  const promo = {
    voucher_promotionid: parseInt(m[1]),
    signature: m[2],
    signature_source:'0'
  };
  await doClaimAll(promo);
  bot.sendMessage(msg.chat.id,'🎉 Klaim voucher via semua cookie selesai.');
});
                            

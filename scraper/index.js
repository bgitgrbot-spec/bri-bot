// =======================
// 🤖 SCRAPER BOT (FINAL)
// =======================
import TelegramBot from "node-telegram-bot-api";
import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import path from "path";
import cron from "node-cron";

const TOKEN = process.env.BOT_SCRAPER_TOKEN;
const CHAT_ID = process.env.SCRAPER_CHAT_ID || process.env.SCRAPER_CHATID;
const LOGIN_URL = process.env.LOGIN_URL;
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

const USERNAME_SELECTOR = process.env.USERNAME_SELECTOR || "input[name='pn']";
const PASSWORD_SELECTOR = process.env.PASSWORD_SELECTOR || "input[name='password']";
const CAPTCHA_SELECTOR = process.env.CAPTCHA_SELECTOR || "img#img_captcha";
const CAPTCHA_INPUT_SELECTOR = process.env.CAPTCHA_INPUT_SELECTOR || "input[name='captcha']";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *"; // default setiap 15 menit

if (!TOKEN || !CHAT_ID || !LOGIN_URL || !USERNAME || !PASSWORD) {
  console.error("❌ ENV missing: BOT_SCRAPER_TOKEN, SCRAPER_CHAT_ID, LOGIN_URL, USERNAME, PASSWORD");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 Scraper Bot aktif (polling)");

// =========================================
// Helper: Tunggu balasan OCR dari grup
// =========================================
function waitForOcrReply(timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let timer;
    function handler(msg) {
      try {
        const chatId = String(msg.chat.id);
        if (chatId !== String(CHAT_ID)) return;
        if (msg.text && msg.text.trim()) {
          bot.removeListener("message", handler);
          clearTimeout(timer);
          resolve(String(msg.text).trim());
        }
      } catch (e) {}
    }
    bot.on("message", handler);
    timer = setTimeout(() => {
      bot.removeListener("message", handler);
      resolve(null);
    }, timeoutMs);
  });
}

// =========================================
// Fungsi utama: Login + Ambil Excel
// =========================================
async function runJob() {
  console.log("→ runJob: starting at", new Date().toISOString());
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // Pilih radio button CRO / MA
    try {
      await page.click("input[name='tipe_user'][value='CRO']");
      await page.waitForTimeout(300);
      console.log("✅ Selected CRO / MA option.");
    } catch (e) {
      console.log("⚠️ Tidak menemukan radio CRO / MA (mungkin default).");
    }

    // Tunggu captcha image muncul
    await page.waitForSelector(CAPTCHA_SELECTOR, { timeout: 15000 });
    const captchaEl = await page.$(CAPTCHA_SELECTOR);

    // Screenshot captcha
    const imgBuffer = await captchaEl.screenshot({ encoding: "binary" });

    // Kirim ke grup Telegram
    await bot.sendPhoto(String(CHAT_ID), imgBuffer, { caption: "📸 CAPTCHA — mohon OCR bantu jawab" });

    // Tunggu balasan OCR
    const reply = await waitForOcrReply(30_000);
    if (!reply) {
      await bot.sendMessage(String(CHAT_ID), "⚠️ Timeout: OCR belum membalas. Coba lagi di jadwal berikutnya.");
      return;
    }
    console.log("📄 OCR reply:", reply);

    // Isi form login
    await page.type(USERNAME_SELECTOR, USERNAME, { delay: 50 });
    await page.type(PASSWORD_SELECTOR, PASSWORD, { delay: 50 });

    // Isi captcha field
    if (await page.$(CAPTCHA_INPUT_SELECTOR)) {
      await page.evaluate((sel, val) => { document.querySelector(sel).value = val; }, CAPTCHA_INPUT_SELECTOR, reply);
    } else {
      const firstTextInput = await page.$("input[type='text']");
      if (firstTextInput) {
        await firstTextInput.type(reply, { delay: 50 });
      } else {
        await bot.sendMessage(String(CHAT_ID), "❌ Gagal menemukan input captcha.");
        return;
      }
    }

    // Klik tombol submit
    const submitBtn = await page.$("button[type='submit'], input[type='submit']");
    if (submitBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
        submitBtn.click()
      ]);
    } else {
      await page.keyboard.press("Enter");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 });
    }

    // Cek login berhasil
    const html = await page.content();
    if (html.includes("Captcha salah") || html.includes("Password salah")) {
      await bot.sendMessage(String(CHAT_ID), "❌ Login gagal: Captcha atau password salah.");
      return;
    }

    console.log("✅ Login berhasil.");

    // Arahkan ke halaman report
    const REPORT_URL = process.env.REPORT_URL || "https://devicelocator.bri.co.id/home.php?dev=report_cpc_atm&title=ATM%20Pengelola";
    await page.goto(REPORT_URL, { waitUntil: "networkidle2", timeout: 20000 });
    await page.waitForTimeout(3000);

    // Filter Pengelola CPC -> BG TANGERANG
    const FILTER_SELECTOR = process.env.FILTER_SELECTOR || "select[name='pengelola']";
    try {
      if (await page.$(FILTER_SELECTOR)) {
        await page.select(FILTER_SELECTOR, "BG TANGERANG");
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      console.log("⚠️ Filter gagal diterapkan, lanjutkan proses.");
    }

    // Cari tombol Download / Excel
    const downloadHandle = await page.$x("//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'download') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'excel')]");
    if (downloadHandle.length === 0) {
      await bot.sendMessage(String(CHAT_ID), "⚠️ Tidak menemukan tombol Download otomatis.");
    } else {
      const href = await page.evaluate(el => el.href, downloadHandle[0]);
      if (href) {
        const cookies = await page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        const resp = await axios.get(href, {
          responseType: "arraybuffer",
          headers: {
            Cookie: cookieHeader,
            Referer: REPORT_URL,
            "User-Agent": "Mozilla/5.0"
          }
        });

        const fileName = `report_${Date.now()}.xlsx`;
        const filePath = `/tmp/${fileName}`;
        fs.writeFileSync(filePath, resp.data);
        await bot.sendDocument(String(CHAT_ID), fs.createReadStream(filePath), {}, { filename: fileName });
        fs.unlinkSync(filePath);
        console.log("📦 Sent report file:", fileName);
      }
    }

  } catch (err) {
    console.error("RUNJOB_ERR:", err?.message || err);
    await bot.sendMessage(String(CHAT_ID), `❌ Error saat scraping: ${err.message || err}`);
  } finally {
    await browser.close();
  }
}

// =========================================
// Jalankan otomatis via cron
// =========================================
cron.schedule(CRON_SCHEDULE, () => {
  console.log("⏰ Cron triggered:", new Date().toISOString());
  runJob();
}, { scheduled: true });

// Manual trigger lewat Telegram
bot.onText(/\/run/, (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId !== String(CHAT_ID)) return;
  bot.sendMessage(chatId, "🚀 Manual trigger dimulai...");
  runJob();
});

console.log("✅ Scraper Bot siap jalan. Cron:", CRON_SCHEDULE);

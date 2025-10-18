// =======================
// 🤖 OCR BOT (FINAL)
// =======================
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import FormData from "form-data";

const TOKEN = process.env.BOT_OCR_TOKEN;
const CHAT_ID = process.env.OCR_BOT_CHAT_ID || process.env.OCR_BOT_CHATID;
const OCR_API_KEY = process.env.OCR_API_KEY; // API key OCR.Space

if (!TOKEN || !OCR_API_KEY) {
  console.error("❌ ENV missing: BOT_OCR_TOKEN and/or OCR_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 OCR Bot aktif (polling).");

// ======================================
// Ketika menerima photo dari grup
// ======================================
bot.on("photo", async (msg) => {
  try {
    const chatId = String(msg.chat.id);
    const fromUser = msg.from?.username || msg.from?.first_name || "Unknown";
    const photos = msg.photo;
    const best = photos[photos.length - 1];

    // (Opsional) Batasi hanya grup tertentu
    if (CHAT_ID && chatId !== String(CHAT_ID)) return;

    // Ambil link file dari Telegram
    const fileLink = await bot.getFileLink(best.file_id);

    console.log(`📷 Captcha diterima dari ${fromUser}. Mengirim ke OCR.space...`);

    // Ambil binary image
    const imageResp = await axios.get(fileLink, { responseType: "arraybuffer" });

    // Kirim ke OCR.space
    const form = new FormData();
    form.append("apikey", OCR_API_KEY);
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("OCREngine", "2");
    form.append("scale", "true");
    form.append("file", imageResp.data, { filename: "captcha.jpg" });

    const ocrResp = await axios.post("https://api.ocr.space/parse/image", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    // Parse hasilnya
    const parsed = ocrResp.data;
    let text = "";
    if (parsed && parsed.ParsedResults && parsed.ParsedResults[0]) {
      text = (parsed.ParsedResults[0].ParsedText || "").trim();
    }

    // Bersihkan hasil OCR (hapus karakter aneh)
    text = text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

    // Kirim hasil ke grup
    if (!text) {
      await bot.sendMessage(chatId, "❌ OCR gagal membaca captcha. Kirim ulang gambarnya ya.");
      console.log("❌ OCR gagal baca captcha.");
      return;
    }

    await bot.sendMessage(chatId, `✅ Hasil OCR: \`${text}\``, { parse_mode: "Markdown" });
    console.log("✅ OCR selesai:", text);

  } catch (err) {
    console.error("OCR_ERR:", err?.message || err);
    await bot.sendMessage(String(msg.chat.id), "❌ Terjadi error saat memproses OCR.");
  }
});

// ======================================
// Tambahan: Command tes manual
// ======================================
bot.onText(/\/ping/, (msg) => {
  bot.sendMessage(msg.chat.id, "🏓 OCR Bot aktif dan siap baca captcha!");
});

console.log("✅ OCR Bot siap jalan. Kirim gambar captcha ke grup Telegram.");

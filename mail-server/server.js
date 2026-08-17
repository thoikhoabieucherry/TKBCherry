"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const PORT = Number(process.env.PORT || 8787);
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const OTP_WINDOW_MS = positiveInteger(process.env.OTP_RATE_WINDOW_MS, 15 * 60 * 1000);
const OTP_MAX_PER_IP = positiveInteger(process.env.OTP_MAX_PER_IP, 20);
const OTP_MAX_PER_EMAIL = positiveInteger(process.env.OTP_MAX_PER_EMAIL, 5);
const DEFAULT_ALLOWED_ORIGINS = [
  "https://tkbcherry.com",
  "https://www.tkbcherry.com",
  "http://127.0.0.1:1010",
  "http://localhost:1010"
];
const ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.TKB_CORS_ORIGIN || process.env.CORS_ORIGIN || DEFAULT_ALLOWED_ORIGINS.join(",")
);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedOrigins(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  );
}

function originAllowed(origin, allowedOrigins = ALLOWED_ORIGINS) {
  if (!origin) return true;
  if (allowedOrigins.has("*")) return true;
  return allowedOrigins.has(String(origin).trim().replace(/\/+$/, ""));
}

function createFixedWindowLimiter(windowMs) {
  const buckets = new Map();
  let nextCleanupAt = 0;
  return {
    consume(key, limit, now = Date.now()) {
      if (now >= nextCleanupAt) {
        for (const [storedKey, stored] of buckets) {
          if (now >= stored.resetAt) buckets.delete(storedKey);
        }
        nextCleanupAt = now + Math.min(windowMs, 60_000);
      }
      const bucketKey = String(key || "unknown");
      const existing = buckets.get(bucketKey);
      const bucket = !existing || now >= existing.resetAt
        ? { count: 0, resetAt: now + windowMs }
        : existing;
      if (bucket.count >= limit) {
        return { allowed: false, retryAfterMs: Math.max(1, bucket.resetAt - now) };
      }
      bucket.count += 1;
      buckets.set(bucketKey, bucket);
      return { allowed: true, retryAfterMs: 0 };
    }
  };
}

const otpLimiter = createFixedWindowLimiter(OTP_WINDOW_MS);
const FROM_NAME = process.env.FROM_NAME || "Thời khóa biểu";

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.warn("[mail-server] Thiếu GMAIL_USER hoặc GMAIL_APP_PASSWORD trong .env — email sẽ KHÔNG gửi được.");
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
});

const app = express();
// Only trust forwarding headers from a reverse proxy on the same machine.
app.set("trust proxy", "loopback");
app.use((req, res, next) => {
  if (!originAllowed(req.get("Origin"))) {
    return res.status(403).json({ ok: false, message: "Nguồn yêu cầu không được phép." });
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(null, originAllowed(origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400
}));
app.use(express.json({ limit: "64kb" }));

function otpEmailHtml(code, purpose) {
  const title = purpose === "password_reset" ? "Đặt lại mật khẩu" : "Xác thực email";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 12px">${title}</h2>
    <p style="margin:0 0 16px;color:#475569">Mã xác thực của bạn là:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;color:#1d4ed8">${code}</div>
    <p style="margin:16px 0 0;color:#64748b;font-size:13px">Mã có hiệu lực trong 15 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
  </div>`;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, configured: !!(GMAIL_USER && GMAIL_APP_PASSWORD) });
});

app.post("/api/send-otp", async (req, res) => {
  const email = String(req.body && req.body.email || "").trim().toLowerCase();
  const code = String(req.body && req.body.code || "").trim();
  const purpose = String(req.body && req.body.purpose || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, message: "Email không hợp lệ." });
  }
  if (!/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ ok: false, message: "Mã không hợp lệ." });
  }
  if (purpose !== "email_verify" && purpose !== "password_reset") {
    return res.status(400).json({ ok: false, message: "Mục đích OTP không hợp lệ." });
  }
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return res.status(500).json({ ok: false, message: "Server chưa cấu hình Gmail." });
  }

  const ipLimit = otpLimiter.consume(`ip:${req.ip || "unknown"}`, OTP_MAX_PER_IP);
  if (!ipLimit.allowed) {
    res.set("Retry-After", String(Math.ceil(ipLimit.retryAfterMs / 1000)));
    return res.status(429).json({
      ok: false,
      message: "Quá nhiều yêu cầu gửi mã. Vui lòng thử lại sau."
    });
  }
  const emailLimit = otpLimiter.consume(`email:${email}`, OTP_MAX_PER_EMAIL);
  if (!emailLimit.allowed) {
    res.set("Retry-After", String(Math.ceil(emailLimit.retryAfterMs / 1000)));
    return res.status(429).json({
      ok: false,
      message: "Quá nhiều yêu cầu gửi mã. Vui lòng thử lại sau."
    });
  }

  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      to: email,
      subject: purpose === "password_reset" ? "Mã đặt lại mật khẩu" : "Mã xác thực email",
      html: otpEmailHtml(code, purpose)
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[mail-server] send failed:", err && err.message);
    res.status(500).json({ ok: false, message: "Không gửi được email." });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[mail-server] đang chạy tại http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  createFixedWindowLimiter,
  originAllowed,
  parseAllowedOrigins,
  positiveInteger
};

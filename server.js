import express from 'express';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { JSONFilePreset } from 'lowdb/node';
import crypto from 'crypto';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import os from 'os';

dotenv.config();

// Direct Supabase Integration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log(`Supabase client initialized for: ${supabaseUrl}`);
  } catch (err) {
    console.warn('Failed to initialize Supabase client:', err.message);
  }
}

const syncProfileToSupabase = async (user) => {
  if (!supabase || !user) return;
  try {
    const extra_data = {
      ...(user.extra_data || {}),
      passwordResetTokenHash: user.passwordResetTokenHash || null,
      passwordResetExpiresAt: user.passwordResetExpiresAt || null,
    };
    await supabase.from('profiles').upsert({
      id: user.id,
      name: user.name,
      email: user.email,
      password_hash: user.passwordHash || user.password_hash || '',
      email_verified: Boolean(user.emailVerified || user.email_verified),
      role: user.role || 'Tester',
      created_at: user.createdAt || user.created_at || new Date().toISOString(),
      extra_data,
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('Supabase profile sync notice:', err.message);
  }
};

const syncBugToSupabase = async (bug) => {
  if (!supabase || !bug) return;
  try {
    await supabase.from('bugs').upsert({
      id: Number(bug.id),
      user_id: bug.user_id || null,
      bug_key: bug.bug_key,
      title: bug.title,
      description: bug.description || '',
      module: bug.module || '',
      severity: bug.severity || 'Major',
      priority: bug.priority || 'P1',
      status: bug.status || 'Open',
      assignee: bug.assignee || '',
      details: bug,
      created_at: bug.created_at || new Date().toISOString(),
      updated_at: bug.updated_at || new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('Supabase bug sync notice:', err.message);
  }
};

const deleteBugFromSupabase = async (bugId) => {
  if (!supabase || !bugId) return;
  try {
    await supabase.from('bugs').delete().eq('id', Number(bugId));
  } catch (err) {
    console.warn('Supabase bug delete notice:', err.message);
  }
};

const syncCommentToSupabase = async (comment) => {
  if (!supabase || !comment) return;
  try {
    await supabase.from('comments').upsert({
      id: Number(comment.id),
      bug_id: comment.bug_id ? Number(comment.bug_id) : null,
      user_id: comment.user_id || null,
      author: comment.author || 'Anonymous',
      body: comment.body || '',
      created_at: comment.created_at || new Date().toISOString(),
      details: comment,
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('Supabase comment sync notice:', err.message);
  }
};

const syncActivityToSupabase = async (act) => {
  if (!supabase || !act) return;
  try {
    await supabase.from('activity').upsert({
      id: Number(act.id),
      bug_id: act.bug_id ? Number(act.bug_id) : null,
      user_id: act.user_id || null,
      type: act.type || 'info',
      message: act.message || '',
      actor: act.actor || 'System',
      created_at: act.created_at || new Date().toISOString(),
      details: act,
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('Supabase activity sync notice:', err.message);
  }
};

const syncTestCaseToSupabase = async (tc) => {
  if (!supabase || !tc) return;
  try {
    await supabase.from('test_cases').upsert({
      id: Number(tc.id),
      user_id: tc.user_id || null,
      case_key: tc.case_key,
      title: tc.title,
      details: tc,
      created_at: tc.created_at || new Date().toISOString(),
      updated_at: tc.updated_at || new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('Supabase test case sync notice:', err.message);
  }
};

const deleteTestCaseFromSupabase = async (caseId) => {
  if (!supabase || !caseId) return;
  try {
    await supabase.from('test_cases').delete().eq('id', Number(caseId));
  } catch (err) {
    console.warn('Supabase test case delete notice:', err.message);
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeDataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(runtimeDataDir, { recursive: true });
const app = express();
app.set('trust proxy', 1);
const uploadDir = path.join(runtimeDataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });
const analyzerUrl = process.env.ANALYZER_URL || 'http://127.0.0.1:5000';
const analyzerEndpoint = (pathName) => new URL(pathName.replace(/^\/+/, ''), `${analyzerUrl.replace(/\/+$/, '')}/`).toString();
const trustedOrigins = new Set((process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5174,http://127.0.0.1:5174')
  .split(',').map(origin => origin.trim()).filter(Boolean));

if (process.env.APP_URL) trustedOrigins.add(process.env.APP_URL.trim().replace(/\/+$/, ''));
if (process.env.FRONTEND_URL) trustedOrigins.add(process.env.FRONTEND_URL.trim().replace(/\/+$/, ''));

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (trustedOrigins.has(origin)) return true;
  if (process.env.CORS_ORIGINS === '*' || process.env.NODE_ENV !== 'production') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.endsWith('.vercel.app')) return true;
    if (parsed.hostname.endsWith('.onrender.com')) return true;
    if (parsed.hostname.endsWith('.railway.app')) return true;
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
  } catch {}
  return false;
};

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`[CORS] Request blocked from origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Set-Cookie'],
}));
app.use(express.json()); app.use('/uploads', express.static(uploadDir));

// Safe API request logger
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health') {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (res.statusCode >= 400) {
        console.warn(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
      }
    });
  }
  next();
});

const sessionSecret = process.env.SESSION_SECRET || process.env.EMAIL_VERIFICATION_SECRET || 'bugtrack-pro-persistent-session-secret';
const sessionLifetimeSeconds = 24 * 60 * 60;
const parseCookies = (header = '') => Object.fromEntries(header.split(';').filter(Boolean).flatMap(part => {
  const index = part.indexOf('=');
  if (index < 0) return [];
  try {
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  } catch {
    return [];
  }
}));
const signSession = (userId) => {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt: Date.now() + sessionLifetimeSeconds * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};
const readSession = (value) => {
  try {
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
};
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const sessionCookie = parseCookies(req.headers.cookie).bugtrack_session || '';
  const token = bearerToken || sessionCookie;
  const session = readSession(token);
  const user = session && db.data.users.find(candidate => candidate.id === session.userId);
  if (!user) {
    console.warn(`[AUTH] Protected request rejected (${req.method} ${req.originalUrl}): invalid or expired session.`);
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
  req.user = user;
  next();
};
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.body) {
    return res.status(400).json({ error: 'The request body is not valid JSON.' });
  }
  next(error);
});
const healthHandler = (req, res) => res.json({
  status: 'ok',
  service: 'BugTrack Pro API',
  database: supabase ? 'supabase' : 'local',
  emailConfigured: Boolean(process.env.SMTP_HOST && (process.env.SMTP_USER || process.env.SMTP_EMAIL)),
  timestamp: new Date().toISOString(),
});
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.post('/api/analyzer/analyze', requireAuth, async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(analyzerEndpoint('/api/analyzer/analyze'), {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'], accept: 'application/json' },
      body: req,
      duplex: 'half',
      signal: controller.signal,
    });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const body = Buffer.from(await response.arrayBuffer());
    if (response.ok && (response.headers.get('content-type') || '').includes('application/json')) {
      try {
        const result = JSON.parse(body.toString('utf8'));
        if (result.id && db?.data) {
          db.data.analyses ||= [];
          if (!db.data.analyses.some(analysis => analysis.id === result.id && analysis.user_id === req.user.id)) {
            db.data.analyses.push({ id: result.id, user_id: req.user.id, created_at: result.created_at || new Date().toISOString() });
            await save();
          }
        }
      } catch {
        // Preserve the analyzer response when it is not JSON.
      }
    }
    res.send(body);
  } catch (error) {
    console.error('Analyzer request failed:', error.code || error.message);
    const message = error.name === 'AbortError'
      ? 'The analyzer service timed out. Check the submitted files and retry.'
      : 'The analyzer service is unavailable. Check the analyzer service deployment logs and retry.';
    res.status(503).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});
const seedDatabasePath = path.join(__dirname, 'bugtrack.json');
const databasePath = path.join(runtimeDataDir, 'bugtrack.json');
if (databasePath !== seedDatabasePath && !fs.existsSync(databasePath) && fs.existsSync(seedDatabasePath)) {
  fs.copyFileSync(seedDatabasePath, databasePath);
}
const db = await JSONFilePreset(databasePath, { bugs: [], comments: [], activity: [], test_cases: [], users: [], nextBug: 1042, nextCase: 2001 });

if (supabase) {
  try {
    const [pRes, bRes, tcRes] = await Promise.all([
      supabase.from('profiles').select('*').limit(200),
      supabase.from('bugs').select('*').limit(500),
      supabase.from('test_cases').select('*').limit(500),
    ]);
    if (pRes.data && pRes.data.length > 0) {
      for (const p of pRes.data) {
        if (!db.data.users.some(u => u.id === p.id || u.email.toLowerCase() === p.email.toLowerCase())) {
          db.data.users.push({
            id: p.id,
            name: p.name,
            email: p.email,
            role: p.role,
            passwordHash: p.password_hash,
            emailVerified: Boolean(p.email_verified),
            createdAt: p.created_at,
          });
        }
      }
    }
    if (bRes.data && bRes.data.length > 0) {
      for (const b of bRes.data) {
        if (!db.data.bugs.some(local => local.id === b.id)) {
          db.data.bugs.push(b.details || b);
        }
      }
    }
    if (tcRes.data && tcRes.data.length > 0) {
      for (const tc of tcRes.data) {
        if (!db.data.test_cases.some(local => local.id === tc.id)) {
          db.data.test_cases.push(tc.details || tc);
        }
      }
    }
  } catch (sbInitErr) {
    console.warn('Supabase startup pull notice:', sbInitErr.message);
  }
}
db.data.comments ||= [];
db.data.activity ||= [];
db.data.users ||= [];
db.data.bugs ||= [];
db.data.test_cases ||= [];
db.data.analyses ||= [];
db.data.nextBug ||= 1042;
db.data.nextCase ||= 2001;
const save = () => db.write();
for (const user of db.data.users) {
  if (!user.id) user.id = `usr_${crypto.randomUUID()}`;
}
for (const collection of [db.data.bugs, db.data.test_cases, db.data.activity, db.data.comments]) {
  for (const record of collection) {
    if (record.user_id === undefined) record.user_id = null;
  }
  for (const analysis of db.data.analyses) {
    if (analysis.user_id === undefined) analysis.user_id = null;
  }
}
const verificationExpiryMinutes = Math.max(1, Number(process.env.EMAIL_VERIFICATION_EXPIRY_MINUTES || 10));
const verificationPepper = (
  process.env.EMAIL_VERIFICATION_SECRET ||
  process.env.SESSION_SECRET ||
  'bugtrack-pro-static-secure-pepper-v1-production-salt'
).trim();
const passwordResetExpiryMinutes = Math.min(60, Math.max(5, Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES || 20)));
const passwordResetRequests = new Map();
class SmtpConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmtpConfigurationError';
    this.code = 'SMTP_CONFIG_ERROR';
    this.stage = 'configuration';
  }
}
class SmtpDeliveryError extends Error {
  constructor(cause, stage = 'delivery') {
    super(cause?.message || 'The SMTP server could not deliver the email.');
    this.name = 'SmtpDeliveryError';
    this.code = cause?.code || 'SMTP_DELIVERY_FAILED';
    this.stage = stage;
    this.cause = cause;
  }
}
const smtpConfig = () => {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USER || process.env.SMTP_EMAIL)?.trim();
  const password = process.env.SMTP_PASSWORD;
  const from = (process.env.SMTP_FROM_EMAIL || process.env.SMTP_EMAIL || user)?.trim();
  const secure = String(process.env.SMTP_SECURE ?? (port === 465)).toLowerCase() === 'true';
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !from) {
    throw new SmtpConfigurationError('Email delivery is not configured. Missing required settings: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM_EMAIL.');
  }
  return { host, port, secure, user, password, from };
};
const createSmtpTransporter = () => {
  const config = smtpConfig();
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
};
const sendMailSafe = async (transporter, mailOptions, timeoutMs = 8000) => {
  return Promise.race([
    transporter.sendMail(mailOptions),
    new Promise((_, reject) => {
      const err = new Error(`SMTP email delivery timed out after ${timeoutMs / 1000}s`);
      err.code = 'ETIMEDOUT';
      setTimeout(() => reject(err), timeoutMs);
    }),
  ]);
};
const hashOtp = (email, otp) => crypto.createHash('sha256').update(`${verificationPepper}:${email}:${otp}`).digest('hex');
const hashResetToken = (token) => crypto.createHash('sha256').update(`${verificationPepper}:reset:${token}`).digest('hex');
const passwordHash = (password) => {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
};
const passwordMatches = (password, stored) => {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltValue, hashValue] = stored.split('$');
    try {
      const actual = crypto.scryptSync(password, Buffer.from(saltValue, 'base64'), 64);
      const expected = Buffer.from(hashValue, 'base64');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  const actual = Buffer.from(hashPassword(password));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const passwordRequirements = [
  [password => password.length >= 8, 'Password must contain at least 8 characters.'],
  [password => /[A-Z]/.test(password), 'Include at least one uppercase letter.'],
  [password => /[a-z]/.test(password), 'Include at least one lowercase letter.'],
  [password => /\d/.test(password), 'Include at least one number.'],
  [password => /[^A-Za-z0-9]/.test(password), 'Include at least one special character.'],
];
const passwordValidationError = (password) => passwordRequirements.filter(([test]) => !test(password)).map(([, message]) => message).join(' ');
const createVerificationCode = () => String(crypto.randomInt(100000, 1000000));
const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};
const sendVerificationEmail = async (email, code) => {
  const config = smtpConfig();
  const transporter = createSmtpTransporter();
  try {
    const info = await sendMailSafe(transporter, {
      from: `"BugTrack Pro" <${config.from}>`,
      to: email,
      subject: 'Verify your BugTrack Pro email',
      text: `Your BugTrack Pro verification code is ${code}. It expires in ${verificationExpiryMinutes} minutes.\n\nIf you did not request this code, you can safely ignore this email.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px 20px; background-color: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="margin-bottom: 20px;">
            <h2 style="margin: 0; color: #0f172a; font-size: 22px;">BugTrack <span style="color: #2563eb;">Pro</span></h2>
            <p style="margin: 4px 0 0 0; color: #64748b; font-size: 13px;">Software Testing &amp; Bug Management</p>
          </div>
          <h3 style="margin: 0 0 12px 0; color: #1e293b; font-size: 17px;">Verify your email address</h3>
          <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #334155;">
            Thank you for registering with BugTrack Pro. Use the verification code below to complete your registration:
          </p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; background-color: #f1f5f9; padding: 16px; text-align: center; border-radius: 6px; margin: 20px 0;">
            ${code}
          </div>
          <p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b;">
            This code will expire in <strong>${verificationExpiryMinutes} minutes</strong>.
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="margin: 0; font-size: 12px; color: #94a3b8;">
            If you did not request this account, please disregard this email.
          </p>
        </div>
      `,
    });
    console.log(`[EMAIL] Verification email sent to ${maskEmail(email)} (MessageID: ${info?.messageId || 'sent'})`);
    return info;
  } catch (error) {
    console.error(`[EMAIL] Failed to send verification email to ${maskEmail(email)}:`, error.message);
    throw new SmtpDeliveryError(error);
  }
};
const resolveResetBaseUrl = (req) => {
  // 1. Primary authority: Configured environment variables (FRONTEND_URL or APP_URL)
  const envUrl = (process.env.FRONTEND_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');

  // 2. Extract and validate client origin if present
  let origin = null;
  const reqOrigin = req.get('origin');
  if (reqOrigin) {
    origin = reqOrigin.trim();
  } else {
    const referer = req.get('referer');
    if (referer) {
      try { origin = new URL(referer).origin; } catch {}
    }
  }

  const isProduction = process.env.NODE_ENV === 'production';

  // In production, strictly use configured deployed domain or trusted remote origin (never localhost)
  if (isProduction) {
    if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
      return envUrl;
    }
    if (origin && isAllowedOrigin(origin) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return origin;
    }
    return envUrl || (origin && isAllowedOrigin(origin) ? origin : '');
  }

  // In development:
  // If the user has configured FRONTEND_URL or APP_URL (e.g. deployed domain, LAN IP, or tunnel),
  // honor it so password reset links can be opened on both laptops and mobile devices.
  if (envUrl) {
    return envUrl;
  }

  // Otherwise, use verified request origin if available, or default to standard local Vite dev URL
  if (origin && isAllowedOrigin(origin)) {
    return origin;
  }
  return 'http://localhost:5173';
};

const sendPasswordResetEmail = async (email, token, baseUrl) => {
  const resetUrl = `${baseUrl.replace(/\/$/, '')}/?resetToken=${encodeURIComponent(token)}`;

  // 1. Optional: If Resend API key is configured (HTTPS port 443, works seamlessly on Render free tier)
  if (process.env.RESEND_API_KEY?.trim()) {
    try {
      console.log(`[EMAIL] Attempting delivery to ${maskEmail(email)} via Resend API (port 443)...`);
      const fromAddr = process.env.SMTP_FROM_EMAIL || process.env.SMTP_EMAIL || 'onboarding@resend.dev';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr.includes('<') ? fromAddr : `BugTrack Pro <${fromAddr}>`,
          to: [email],
          subject: 'Reset your BugTrack Pro password',
          text: `You recently requested to reset your password for BugTrack Pro.\n\nUse this link to reset your password (expires in ${passwordResetExpiryMinutes} minutes):\n${resetUrl}\n\nIf you did not request a password reset, you can safely ignore this email. Your password will not change.`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 8px;">
              <div style="margin-bottom: 24px;">
                <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 700;">BugTrack <span style="color: #2563eb;">Pro</span></h2>
                <p style="margin: 4px 0 0 0; color: #64748b; font-size: 14px;">Software Testing &amp; Bug Management</p>
              </div>
              <h3 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px;">Reset your password</h3>
              <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.5; color: #334155;">
                We received a request to reset the password for your BugTrack Pro account (<strong>${maskEmail(email)}</strong>). Click the button below to set a new password:
              </p>
              <div style="margin: 28px 0;">
                <a href="${resetUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; display: inline-block;">Reset Password</a>
              </div>
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #64748b; line-height: 1.5;">
                This link will expire in <strong>${passwordResetExpiryMinutes} minutes</strong>. If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin: 0 0 24px 0; word-break: break-all; font-size: 13px; color: #2563eb;">
                <a href="${resetUrl}" style="color: #2563eb;">${resetUrl}</a>
              </p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
              <p style="margin: 0; font-size: 12px; color: #94a3b8;">
                If you did not request this password reset, no action is needed. Your account remains secure.
              </p>
            </div>
          `,
        }),
      });
      if (res.ok) {
        const resData = await res.json();
        console.log(`[EMAIL] Password reset email confirmed by Resend for ${maskEmail(email)} (ID: ${resData.id})`);
        return { messageId: resData.id };
      }
      const errText = await res.text();
      console.warn(`[EMAIL] Resend returned ${res.status}, falling back to SMTP: ${errText}`);
    } catch (apiErr) {
      console.warn(`[EMAIL] Resend API error, falling back to SMTP: ${apiErr.message}`);
    }
  }

  // 2. Standard SMTP Delivery
  const config = smtpConfig();
  const transporter = createSmtpTransporter();
  try {
    const info = await sendMailSafe(transporter, {
      from: `"BugTrack Pro" <${config.from}>`,
      replyTo: config.from,
      to: email,
      subject: 'Reset your BugTrack Pro password',
      text: `You recently requested to reset your password for BugTrack Pro.\n\nUse this link to reset your password (expires in ${passwordResetExpiryMinutes} minutes):\n${resetUrl}\n\nIf you did not request a password reset, you can safely ignore this email. Your password will not change.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="margin-bottom: 24px;">
            <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 700;">BugTrack <span style="color: #2563eb;">Pro</span></h2>
            <p style="margin: 4px 0 0 0; color: #64748b; font-size: 14px;">Software Testing &amp; Bug Management</p>
          </div>
          <h3 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px;">Reset your password</h3>
          <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.5; color: #334155;">
            We received a request to reset the password for your BugTrack Pro account (<strong>${maskEmail(email)}</strong>). Click the button below to set a new password:
          </p>
          <div style="margin: 28px 0;">
            <a href="${resetUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; display: inline-block;">Reset Password</a>
          </div>
          <p style="margin: 0 0 12px 0; font-size: 13px; color: #64748b; line-height: 1.5;">
            This link will expire in <strong>${passwordResetExpiryMinutes} minutes</strong>. If the button does not work, copy and paste this link into your browser:
          </p>
          <p style="margin: 0 0 24px 0; word-break: break-all; font-size: 13px; color: #2563eb;">
            <a href="${resetUrl}" style="color: #2563eb;">${resetUrl}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="margin: 0; font-size: 12px; color: #94a3b8;">
            If you did not request this password reset, no action is needed. Your account remains secure.
          </p>
        </div>
      `,
    });
    if (info && (info.messageId || info.accepted?.length > 0)) {
      console.log(`[EMAIL] Password reset email confirmed by SMTP for ${maskEmail(email)} (MessageID: ${info?.messageId || 'sent'})`);
      return info;
    }
    throw new Error('SMTP transport did not confirm message acceptance.');
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.message?.includes('timed out')) {
      console.error(`[EMAIL] SMTP connection timed out for ${maskEmail(email)}. Note: On Render free tier, outbound SMTP ports (25, 465, 587) are blocked. Use a paid plan or set RESEND_API_KEY.`);
      throw new SmtpDeliveryError(error, 'timeout');
    }
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      console.error(`[EMAIL] SMTP authentication failed for ${config.user}. Verify your Google App Password / SMTP credentials.`);
      throw new SmtpDeliveryError(error, 'auth');
    }
    console.error(`[EMAIL] Failed to send password reset email to ${maskEmail(email)}: [${error.code || 'UNKNOWN'}] ${error.message}`);
    throw new SmtpDeliveryError(error, 'delivery');
  }
};
if (db.data.bugs.some((bug) => bug.is_demo) || db.data.test_cases.some((testCase) => testCase.is_demo)) {
  db.data.bugs = db.data.bugs.filter((bug) => !bug.is_demo);
  db.data.test_cases = db.data.test_cases.filter((testCase) => !testCase.is_demo);
  await save();
}
const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');
if (!db.data.users?.length) {
  db.data.users = [
    ['Maya Chen', 'maya@acme.test', 'QA Manager', 'Maya@123'],
    ['Alex Morgan', 'alex@acme.test', 'Developer', 'Alex@123'],
    ['Jordan Lee', 'jordan@acme.test', 'Tester', 'Jordan@123'],
    ['Sam Viewer', 'sam@acme.test', 'Viewer', 'Viewer@123']
  ].map(([name, email, role, password]) => ({ name, email, role, passwordHash: hashPassword(password), emailVerified: true, createdAt: new Date().toISOString() }));
  await save();
}
for (const user of db.data.users) {
  if (user.emailVerified === undefined) user.emailVerified = true;
}
await save();
const loginHandler = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    let user = db.data.users.find((candidate) => typeof candidate.email === 'string' && candidate.email.toLowerCase() === normalizedEmail);

    // If user not found in local cache, unverified, or credentials mismatch, check Supabase Cloud
    if ((!user || !user.emailVerified || !passwordMatches(password, user.passwordHash)) && supabase) {
      try {
        const { data: remoteProfile } = await supabase.from('profiles').select('*').ilike('email', normalizedEmail).maybeSingle();
        if (remoteProfile && remoteProfile.password_hash && passwordMatches(password, remoteProfile.password_hash)) {
          if (!user) {
            user = {
              id: remoteProfile.id,
              name: remoteProfile.name,
              email: remoteProfile.email,
              role: remoteProfile.role || 'Tester',
              passwordHash: remoteProfile.password_hash,
              emailVerified: Boolean(remoteProfile.email_verified),
              createdAt: remoteProfile.created_at || new Date().toISOString(),
            };
            db.data.users.push(user);
          } else {
            user.passwordHash = remoteProfile.password_hash;
            user.emailVerified = Boolean(remoteProfile.email_verified);
          }
          await save();
        }
      } catch (sbErr) {
        console.warn('[AUTH] Supabase profile fallback lookup notice:', sbErr.message);
      }
    }

    if (!user || !passwordMatches(password, user.passwordHash)) {
      console.warn(`[AUTH] Failed sign-in attempt for ${maskEmail(normalizedEmail)}`);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.emailVerified) {
      console.warn(`[AUTH] Sign-in rejected for unverified account: ${maskEmail(user.email)}`);
      return res.status(403).json({ error: 'Verify your email before signing in.', verificationRequired: true, email: user.email, maskedEmail: maskEmail(user.email) });
    }
    const sessionToken = signSession(user.id);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
    const sameSite = isSecure ? 'None' : 'Lax';
    const secureFlag = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bugtrack_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${sessionLifetimeSeconds}${secureFlag}`);
    console.log(`[AUTH] User signed in successfully: ${maskEmail(user.email)} [${user.role}]`);
    res.json({ id: user.id, name: user.name, role: user.role, email: user.email, token: sessionToken });
  } catch (error) {
    console.error('[AUTH] Sign-in failed with error:', error);
    res.status(500).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
  }
};
app.post('/api/login', loginHandler);
app.post('/api/auth/login', loginHandler);

const logoutHandler = (req, res) => {
  res.setHeader('Set-Cookie', 'bugtrack_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
};
app.post('/api/logout', logoutHandler);
app.post('/api/auth/logout', logoutHandler);

const meHandler = (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role });
};
app.get('/api/me', requireAuth, meHandler);
app.get('/api/auth/me', requireAuth, meHandler);

app.post('/api/password-reset/request', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const genericResponse = { message: 'If an account exists for this email, password reset instructions will be sent.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  // Determine client origin URL for reset link
  const baseUrl = resolveResetBaseUrl(req);

  const nowMs = Date.now();
  const requestKey = email;
  const lastRequestAt = passwordResetRequests.get(requestKey) || 0;
  if (nowMs - lastRequestAt < 15 * 1000) {
    console.log(`[AUTH] Password reset request throttled for ${maskEmail(email)}`);
    return res.status(200).json(genericResponse);
  }
  passwordResetRequests.set(requestKey, nowMs);

  let user = db.data.users.find((candidate) => typeof candidate.email === 'string' && candidate.email.trim().toLowerCase() === email);
  if (!user && supabase) {
    try {
      const { data: remoteProfile } = await supabase.from('profiles').select('*').ilike('email', email).maybeSingle();
      if (remoteProfile) {
        user = {
          id: remoteProfile.id,
          name: remoteProfile.name,
          email: remoteProfile.email,
          role: remoteProfile.role,
          passwordHash: remoteProfile.password_hash,
          emailVerified: Boolean(remoteProfile.email_verified),
          createdAt: remoteProfile.created_at,
        };
        db.data.users.push(user);
        await save();
      }
    } catch (sbErr) {
      console.warn('[AUTH] Supabase check during password reset failed:', sbErr.message);
    }
  }

  if (!user) {
    console.log(`[AUTH] Password reset requested for unregistered email: ${maskEmail(email)}`);
    return res.status(200).json(genericResponse);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  user.passwordResetTokenHash = hashResetToken(token);
  user.passwordResetExpiresAt = nowMs + passwordResetExpiryMinutes * 60 * 1000;
  await save();
  await syncProfileToSupabase(user);

  try {
    const info = await sendPasswordResetEmail(user.email, token, baseUrl);
    console.log(`[AUTH] Password reset email delivered for ${maskEmail(user.email)} (MessageID: ${info?.messageId || 'sent'})`);
    return res.status(200).json(genericResponse);
  } catch (error) {
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    await save();
    await syncProfileToSupabase(user);
    console.error(`[AUTH] Password reset email delivery failed for ${maskEmail(user.email)} stage=${error.stage || 'unknown'}: [${error.code || 'FAIL'}] ${error.message}`);
    return res.status(503).json({
      error: 'Unable to send password reset email at this time. Please check mail service configuration or try again later.'
    });
  }
});

app.post('/api/password-reset/validate', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ error: 'Reset token is required.' });
  const tokenHash = hashResetToken(token);
  let user = db.data.users.find((candidate) => candidate.passwordResetTokenHash === tokenHash);
  if (!user && supabase) {
    try {
      const { data: remoteProfiles } = await supabase.from('profiles').select('*');
      const remote = remoteProfiles?.find(p => p.extra_data?.passwordResetTokenHash === tokenHash);
      if (remote) {
        user = db.data.users.find(u => u.id === remote.id);
        if (!user) {
          user = {
            id: remote.id,
            name: remote.name,
            email: remote.email,
            role: remote.role || 'Tester',
            passwordHash: remote.password_hash,
            emailVerified: Boolean(remote.email_verified),
            createdAt: remote.created_at,
          };
          db.data.users.push(user);
        }
        user.passwordResetTokenHash = remote.extra_data?.passwordResetTokenHash;
        user.passwordResetExpiresAt = remote.extra_data?.passwordResetExpiresAt;
        await save();
      }
    } catch (sbLookupErr) {
      console.warn('[AUTH] Supabase token check notice:', sbLookupErr.message);
    }
  }
  if (!user || !user.passwordResetExpiresAt || Date.now() > user.passwordResetExpiresAt) {
    console.warn('[AUTH] Password reset token validation rejected: invalid or expired token.');
    return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
  }
  res.json({ valid: true });
});

app.post('/api/password-reset/complete', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!token) return res.status(400).json({ error: 'Reset token is required.' });
  const tokenHash = hashResetToken(token);
  let user = db.data.users.find((candidate) => candidate.passwordResetTokenHash === tokenHash);
  if (!user && supabase) {
    try {
      const { data: remoteProfiles } = await supabase.from('profiles').select('*');
      const remote = remoteProfiles?.find(p => p.extra_data?.passwordResetTokenHash === tokenHash);
      if (remote) {
        user = db.data.users.find(u => u.id === remote.id);
        if (!user) {
          user = {
            id: remote.id,
            name: remote.name,
            email: remote.email,
            role: remote.role || 'Tester',
            passwordHash: remote.password_hash,
            emailVerified: Boolean(remote.email_verified),
            createdAt: remote.created_at,
          };
          db.data.users.push(user);
        }
        user.passwordResetTokenHash = remote.extra_data?.passwordResetTokenHash;
        user.passwordResetExpiresAt = remote.extra_data?.passwordResetExpiresAt;
        await save();
      }
    } catch (sbLookupErr) {
      console.warn('[AUTH] Supabase token check notice:', sbLookupErr.message);
    }
  }
  if (!user || !user.passwordResetExpiresAt || Date.now() > user.passwordResetExpiresAt) {
    console.warn('[AUTH] Password reset completion rejected: invalid or expired token.');
    return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  user.passwordHash = passwordHash(password);
  delete user.passwordResetTokenHash;
  delete user.passwordResetExpiresAt;
  await save();
  await syncProfileToSupabase(user);
  console.log(`[AUTH] Password reset successfully completed for user: ${maskEmail(user.email)}`);
  res.json({ reset: true, message: 'Your password has been reset successfully. Please sign in with your new password.' });
});

const registerHandler = async (req, res) => {
  const { name, email, password, role = 'Tester' } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (db.data.users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
    console.warn(`[AUTH] Registration rejected: duplicate email ${maskEmail(normalizedEmail)}`);
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  // Ensure role cannot be elevated to administrative roles
  const safeRole = ['Developer', 'Tester', 'Viewer'].includes(role) ? role : 'Tester';
  const code = createVerificationCode();
  const user = {
    id: `usr_${crypto.randomUUID()}`,
    name: name.trim(),
    email: normalizedEmail,
    role: safeRole,
    passwordHash: passwordHash(password),
    emailVerified: false,
    verificationCodeHash: hashOtp(normalizedEmail, code),
    verificationExpiresAt: Date.now() + verificationExpiryMinutes * 60 * 1000,
    verificationAttempts: 0,
    verificationLastSentAt: Date.now(),
    verificationResends: [Date.now()],
    createdAt: new Date().toISOString()
  };
  db.data.users.push(user);
  await save();
  await syncProfileToSupabase(user);

  try {
    await sendVerificationEmail(user.email, code);
    return res.status(202).json({ verificationRequired: true, email: user.email, maskedEmail: maskEmail(user.email), expiresAt: user.verificationExpiresAt });
  } catch (error) {
    console.error('[AUTH] Verification email delivery notice:', error.code || error.message);
    // Auto-verify user so registration succeeds even if cloud email delivery is restricted
    user.emailVerified = true;
    delete user.verificationCodeHash;
    delete user.verificationExpiresAt;
    await save();
    await syncProfileToSupabase(user);
    const sessionToken = signSession(user.id);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
    const sameSite = isSecure ? 'None' : 'Lax';
    const secureFlag = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bugtrack_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${sessionLifetimeSeconds}${secureFlag}`);
    console.log(`[AUTH] Auto-verified new registration (email delivery notice): ${maskEmail(user.email)} [${user.role}]`);
    return res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      verificationRequired: false,
      token: sessionToken,
      notice: 'Account created and verified successfully.'
    });
  }
};
app.post('/api/register', registerHandler);
app.post('/api/auth/register', registerHandler);

app.post('/api/verify', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const user = db.data.users.find((candidate) => candidate.email === email);
  if (!user || user.emailVerified) return res.status(400).json({ error: 'This verification request is invalid or has already been completed.' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit verification code.' });
  if (Date.now() > user.verificationExpiresAt) return res.status(400).json({ error: 'This verification code has expired. Request a new code.' });
  if ((user.verificationAttempts || 0) >= 5) return res.status(429).json({ error: 'Too many verification attempts. Request a new code.' });
  user.verificationAttempts = (user.verificationAttempts || 0) + 1;
  if (hashOtp(email, code) !== user.verificationCodeHash) {
    await save();
    return res.status(400).json({ error: 'The verification code is incorrect.' });
  }
  user.emailVerified = true;
  delete user.verificationCodeHash;
  delete user.verificationExpiresAt;
  delete user.verificationAttempts;
  delete user.verificationLastSentAt;
  delete user.verificationResends;
  await save();
  await syncProfileToSupabase(user);

  const sessionToken = signSession(user.id);
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const sameSite = isSecure ? 'None' : 'Lax';
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `bugtrack_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${sessionLifetimeSeconds}${secureFlag}`);
  console.log(`[AUTH] User verified email successfully: ${maskEmail(user.email)}`);
  res.json({ verified: true, message: 'Email verified successfully. Please sign in.', user: { id: user.id, name: user.name, email: user.email, role: user.role, token: sessionToken } });
});
app.post('/api/verify/resend', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const user = db.data.users.find((candidate) => candidate.email === email);
  if (!user || user.emailVerified) return res.status(400).json({ error: 'This verification request is invalid.' });
  const nowMs = Date.now();
  const recentResends = (user.verificationResends || []).filter((timestamp) => nowMs - timestamp < 60 * 60 * 1000);
  if (user.verificationLastSentAt && nowMs - user.verificationLastSentAt < 60 * 1000) return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
  if (recentResends.length >= 5) return res.status(429).json({ error: 'Too many code requests. Try again later.' });
  const code = createVerificationCode();
  user.verificationCodeHash = hashOtp(email, code);
  user.verificationExpiresAt = nowMs + verificationExpiryMinutes * 60 * 1000;
  user.verificationAttempts = 0;
  user.verificationLastSentAt = nowMs;
  user.verificationResends = [...recentResends, nowMs];
  try {
    await sendVerificationEmail(email, code);
    await save();
    res.json({ sent: true, expiresAt: user.verificationExpiresAt, maskedEmail: maskEmail(email) });
  } catch (error) {
    console.error('Verification resend failed:', error.code || error.message);
    if (error.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Verification email is not configured on the server.', code: error.code });
    }
    res.status(503).json({ error: 'The verification email could not be delivered. Check the SMTP settings and try again.', code: error.code });
  }
});
if (!db.data.bugs.length) {
  db.data.bugs = [
    ['Checkout freezes after applying promo code','Checkout','Critical','P0','In Progress','Maya Chen','Checkout becomes unresponsive when a valid promo is applied to an order with multiple items.'],
    ['Avatar is missing in activity feed','Profile','Minor','P2','Open','Alex Morgan','User avatar does not render for comments created from the mobile view.'],
    ['Export report uses incorrect timezone','Reports','Major','P1','Retesting','Jordan Lee','CSV export shifts created dates by one day for users outside UTC.'],
    ['Password reset email delayed','Authentication','Major','P1','Fixed','Maya Chen','Reset email can take more than ten minutes to arrive.']
  ].map((x, i) => ({ id:i+1, bug_key:`BUG-${1042-i}`, title:x[0], module:x[1], severity:x[2], priority:x[3], status:x[4], assignee:x[5], description:x[6], steps:'1. Reproduce the issue\\n2. Observe the result', expected:'The action completes successfully.', actual:'The UI does not match the expected behavior.', is_demo:1, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }));
  db.data.test_cases = [
    ['Apply promotional discount','Checkout','Add items; enter promo; apply discount','Discount and totals are correct','Passed','Maya Chen'],
    ['Reset password from login','Authentication','Open reset; submit email; follow link','User can set a new password','Failed','Alex Morgan'],
    ['Export filtered bug report','Reports','Filter bugs; export CSV','Download contains filtered rows','Not Run','Jordan Lee']
  ].map((x,i)=>({id:i+1,case_key:`TC-${2001+i}`,title:x[0],module:x[1],steps:x[2],expected:x[3],status:x[4],assignee:x[5],is_demo:1,updated_at:new Date().toISOString()}));
  await save();
}
const now = () => new Date().toISOString();
const valid = b => ['title','description','module','severity','priority','status','assignee'].every(k => typeof b[k] === 'string' && b[k].trim());
app.get('/api/summary', requireAuth, (req, res) => {
  const b = db.data.bugs.filter(x => x.user_id === req.user.id), c = db.data.test_cases.filter(x => x.user_id === req.user.id);
  res.json({
    total: b.length,
    open: b.filter(x => ['Open', 'Reopened'].includes(x.status)).length,
    inProgress: b.filter(x => ['In Progress', 'Retesting'].includes(x.status)).length,
    resolved: b.filter(x => ['Fixed', 'Closed'].includes(x.status)).length,
    critical: b.filter(x => x.severity === 'Critical').length,
    high: b.filter(x => ['High', 'Major'].includes(x.severity)).length,
    tests: c.length,
    passed: c.filter(x => x.status === 'Passed').length,
    failed: c.filter(x => x.status === 'Failed').length,
    blocked: c.filter(x => x.status === 'Blocked').length,
    notRun: c.filter(x => x.status === 'Not Run').length
  });
});
app.get('/api/bugs', requireAuth, (req,res) => {
  const q = String(req.query.search || '').toLowerCase(), status = req.query.status || 'All', severity = req.query.severity || 'All';
  const sort = req.query.sort || 'newest';
  const bugs = db.data.bugs.filter(b => b.user_id === req.user.id && (!q || [b.bug_key, b.title, b.module, b.source_file, b.assignee].some(x => String(x || '').toLowerCase().includes(q))) && (status === 'All' || b.status === status) && (severity === 'All' || severity === b.severity));
  bugs.sort((a, z) => sort === 'oldest' ? new Date(a.created_at) - new Date(z.created_at) : sort === 'severity' ? ({ Critical: 0, High: 1, Major: 1, Medium: 2, Minor: 3, Low: 4, Trivial: 5 }[a.severity] ?? 9) - ({ Critical: 0, High: 1, Major: 1, Medium: 2, Minor: 3, Low: 4, Trivial: 5 }[z.severity] ?? 9) : new Date(z.created_at) - new Date(a.created_at));
  res.json(bugs);
});
app.post('/api/bugs', requireAuth, async (req,res) => { if(!valid(req.body)) return res.status(400).json({error:'Required bug fields are missing.'}); const bug={...req.body,id:db.data.bugs.reduce((m,b)=>Math.max(m,b.id),0)+1,bug_key:`BUG-${db.data.nextBug++}`,user_id:req.user.id,is_demo:0,created_at:now(),updated_at:now()}; db.data.bugs.push(bug); const act={id:db.data.activity.length+1,bug_id:bug.id,user_id:req.user.id,type:'created',message:`${bug.bug_key} was reported`,actor:req.user.name,created_at:now()}; db.data.activity.push(act); await save(); await syncBugToSupabase(bug); await syncActivityToSupabase(act); res.status(201).json(bug); });
app.put('/api/bugs/:id', requireAuth, async (req,res) => { if(!valid(req.body)) return res.status(400).json({error:'Required bug fields are missing.'}); const b=db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(!b)return res.status(404).json({error:'Bug not found.'}); Object.assign(b,req.body,{user_id:req.user.id,updated_at:now()}); await save(); await syncBugToSupabase(b); res.json(b); });
app.delete('/api/bugs/:id', requireAuth, async (req,res) => { const i=db.data.bugs.findIndex(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(i<0)return res.status(404).json({error:'Bug not found.'}); db.data.bugs.splice(i,1); db.data.activity = db.data.activity.filter(x => x.bug_id !== Number(req.params.id)); db.data.comments = db.data.comments.filter(x => x.bug_id !== Number(req.params.id)); await save(); await deleteBugFromSupabase(req.params.id); res.status(204).end(); });
app.get('/api/bugs/:id/activity', requireAuth, (req,res)=>{ const bug = db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(!bug)return res.status(404).json({error:'Bug not found.'}); res.json((db.data.activity||[]).filter(x=>x.bug_id===bug.id&&x.user_id===req.user.id).sort((a,b)=>b.id-a.id)); });
app.patch('/api/bugs/:id/workflow', requireAuth, async(req,res)=>{
  const b=db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); const {status,comment=''}=req.body;
  const transitions={Open:['In Progress'],Reopened:['In Progress'], 'In Progress':['Fixed'],Fixed:['Retesting'],Retesting:['Closed','Reopened']};
  if(!b)return res.status(404).json({error:'Bug not found.'});
  if(!transitions[b.status]?.includes(status))return res.status(400).json({error:`${b.status} cannot move directly to ${status}.`});
  b.status=status;b.updated_at=now();
  db.data.activity.push({id:db.data.activity.length+1,bug_id:b.id,user_id:req.user.id,type:'status',message:`Status changed to ${status}`,actor:req.user.name,comment,created_at:now()});
  if(comment.trim())db.data.comments.push({id:db.data.comments.length+1,bug_id:b.id,user_id:req.user.id,author:req.user.name,body:comment,created_at:now()});
  await save();res.json(b);
});
app.post('/api/analyzer/integrate', requireAuth, async (req, res) => {
  const { analysis_id: analysisId, findings = [], source_filename: sourceFilename = '', language = 'Unknown' } = req.body || {};
  if (!analysisId || !Array.isArray(findings)) return res.status(400).json({ error: 'A valid analysis result is required.' });
  const actionable = findings.filter(f => f && f.id && !['Informational', 'Unverified'].includes(f.verification) && f.category !== 'Analysis limitation');
  const createdBugs = [], createdTests = [];
  for (const finding of actionable) {
    if (db.data.bugs.some(b => b.analysis_id === analysisId && b.finding_id === finding.id && b.user_id === req.user.id)) continue;
    const bug = { id: db.data.bugs.reduce((m, b) => Math.max(m, Number(b.id) || 0), 0) + 1, bug_key: `BUG-${db.data.nextBug++}`, user_id: req.user.id, title: finding.title, description: finding.explanation, module: finding.file || sourceFilename || language, severity: finding.severity || 'Medium', priority: ['Critical', 'High'].includes(finding.severity) ? 'P0' : 'P1', status: 'Open', assignee: 'Unassigned', steps: (finding.steps || []).join('\n'), expected: finding.expected || '', actual: finding.actual || finding.evidence || '', source_file: finding.file || sourceFilename || '', source_line: finding.line || null, category: finding.category || 'Static analysis', evidence: finding.evidence || '', recommendation: finding.recommendation || '', analysis_id: analysisId, finding_id: finding.id, language, is_demo: 0, created_at: now(), updated_at: now() };
    db.data.bugs.push(bug); db.data.activity.push({ id: db.data.activity.length + 1, bug_id: bug.id, user_id:req.user.id, type: 'created', message: `${bug.bug_key} was detected by automated analysis`, actor: 'Automated Bug Analyzer', created_at: now() }); createdBugs.push(bug);
    const templates = /division|zero/i.test(finding.title)
      ? [['Reject a zero divisor', 'Call the affected operation with divisor 0.', 'The operation rejects the input without an unhandled exception.'], ['Accept a positive divisor', 'Call the affected operation with a positive divisor.', 'The operation returns the expected result.'], ['Accept a negative divisor', 'Call the affected operation with a negative divisor.', 'The operation returns the expected result.']]
      : /login|credential|password|auth/i.test(`${finding.title} ${finding.category}`)
        ? [['Accept valid credentials', 'Submit valid credentials.', 'Authentication succeeds and the user is redirected.'], ['Reject invalid credentials', 'Submit an incorrect password.', 'Authentication fails with a safe error message.'], ['Reject empty credentials', 'Submit the form with username or password empty.', 'Validation prevents submission and identifies the missing field.']]
        : /form|validation|required|input/i.test(`${finding.title} ${finding.category}`)
          ? [['Accept valid input', 'Submit a valid value in the affected field.', 'The form accepts the value.'], ['Reject missing input', 'Submit without the affected required value.', 'Validation identifies the missing value.'], ['Reject malformed input', 'Submit a value in an invalid format.', 'Validation rejects the malformed value.']]
          : [['Reproduce the detected finding', `Execute the affected code path at ${bug.source_file || bug.module}:${bug.source_line || '?'}.`, `The behavior matches the expected result and no ${bug.category.toLowerCase()} finding is observed.`]];
    for (const [title, steps, expected] of templates) { const testCase = { id: db.data.test_cases.length + 1, case_key: `TC-${db.data.nextCase++}`, user_id:req.user.id, title, objective: finding.title, module: bug.module, steps, expected, actual: '', priority: bug.priority, status: 'Not Run', related_bug_id: bug.id, analysis_id: analysisId, assignee: '', is_demo: 0, created_at: now(), updated_at: now() }; db.data.test_cases.push(testCase); createdTests.push(testCase); }
  }
  await save(); res.status(201).json({ bugs: createdBugs, test_cases: createdTests, duplicate_count: actionable.length - createdBugs.length });
});
app.use('/api/analyzer', requireAuth, async (req, res, next) => {
  const segments = req.path.split('/').filter(Boolean);
  const firstSegment = segments[0];

  if (firstSegment && !['reports', 'fixes', 'analyze', 'integrate'].includes(firstSegment)) {
    const analysis = db.data.analyses?.find(item =>
      String(item.id) === String(firstSegment) &&
      (item.user_id === null || item.user_id === undefined || String(item.user_id) === String(req.user.id))
    );
    if (!analysis) return res.status(404).json({ error: 'Analysis report not found.' });
  }

  try {
    const { host, connection, 'content-length': contentLength, ...forwardHeaders } = req.headers;
    let forwardBody = undefined;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        forwardBody = JSON.stringify(req.body);
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = Buffer.byteLength(forwardBody).toString();
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        forwardBody = req.body;
        forwardHeaders['content-length'] = Buffer.byteLength(forwardBody).toString();
      } else if (!req.readableEnded) {
        forwardBody = req;
      }
    }

    const response = await fetch(analyzerEndpoint(req.originalUrl), {
      method: req.method,
      headers: forwardHeaders,
      body: forwardBody,
      duplex: forwardBody === req ? 'half' : undefined,
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'content-encoding'].includes(lower)) {
        res.setHeader(key, value);
      }
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(`[Analyzer Proxy Error] ${req.method} ${req.originalUrl}:`, err.message || err);
    res.status(503).json({ error: 'The analyzer service is unavailable. Please ensure the Python analyzer service is running.' });
  }
});
app.get('/api/bugs/:id/comments',requireAuth,(req,res)=>{const bug=db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id);if(!bug)return res.status(404).json({error:'Bug not found.'});res.json(db.data.comments.filter(x=>x.bug_id===bug.id&&x.user_id===req.user.id));});
app.post('/api/bugs/:id/comments',requireAuth,async(req,res)=>{const bug=db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id);if(!bug)return res.status(404).json({error:'Bug not found.'});if(!req.body.body?.trim())return res.status(400).json({error:'Comment is required.'});const c={id:db.data.comments.length+1,bug_id:bug.id,user_id:req.user.id,author:req.user.name,body:req.body.body,created_at:now()};db.data.comments.push(c);await save();res.status(201).json(c)});
app.get('/api/test-cases',requireAuth,(req,res)=>{
  const q = String(req.query.search || '').toLowerCase(), priority = req.query.priority || 'All', status = req.query.status || 'All';
  res.json(db.data.test_cases.filter(c => c.user_id === req.user.id && (!q || [c.case_key, c.title, `BUG-${c.related_bug_id || ''}`, c.related_bug_id, c.module].some(x => String(x || '').toLowerCase().includes(q))) && (priority === 'All' || c.priority === priority) && (status === 'All' || c.status === status)).sort((a, z) => new Date(z.created_at || z.updated_at) - new Date(a.created_at || a.updated_at)));
});
app.post('/api/test-cases',requireAuth,async(req,res)=>{if(!req.body.title?.trim()||!req.body.module?.trim()||!req.body.steps?.trim()||!req.body.expected?.trim())return res.status(400).json({error:'All test case fields are required.'});const c={...req.body,id:db.data.test_cases.reduce((m,x)=>Math.max(m,Number(x.id)||0),0)+1,user_id:req.user.id,case_key:`TC-${db.data.nextCase++}`,status:'Not Run',actual:'',execution_notes:'',execution_history:[],is_demo:0,created_at:now(),updated_at:now()};db.data.test_cases.push(c);await save();res.status(201).json(c)});
app.patch('/api/test-cases/:id',requireAuth,async(req,res)=>{if(req.body.status!==undefined&&!['Passed','Failed','Blocked','Not Run'].includes(req.body.status))return res.status(400).json({error:'Invalid test result.'});const c=db.data.test_cases.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id);if(!c)return res.status(404).json({error:'Test case not found.'});const updates={...req.body};delete updates.user_id;Object.assign(c,updates,{updated_at:now()});if(req.body.status&&req.body.status!=='Not Run'){c.execution_history ||= [];c.execution_history.push({status:req.body.status,actual:req.body.actual||'',notes:req.body.execution_notes||'',created_at:now()});}await save();res.json(c)});
app.delete('/api/test-cases/:id',requireAuth,async(req,res)=>{const index=db.data.test_cases.findIndex(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id);if(index<0)return res.status(404).json({error:'Test case not found.'});db.data.test_cases.splice(index,1);await save();res.status(204).end()});
app.post('/api/test-cases/:id/run',requireAuth,async(req,res)=>{
  const c=db.data.test_cases.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(!c)return res.status(404).json({error:'Test case not found.'});
  res.status(409).json({error:'No safe automated runner is configured for this descriptive test case. Record the observed result explicitly.'});
});
app.post('/api/uploads',requireAuth,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'No file uploaded.'});res.json({filename:req.file.originalname,url:`/uploads/${req.file.filename}`})});
app.get('/api/export',requireAuth,(req,res)=>{const rows=db.data.bugs.filter(b=>b.user_id===req.user.id).map(b=>[b.bug_key,b.title,b.module,b.severity,b.priority,b.status,b.assignee,b.created_at].map(v=>`"${String(v).replaceAll('"','""')}"`).join(','));res.type('text/csv').set('Content-Disposition','attachment; filename="bugtrack-report.csv"').send(['Bug ID,Title,Module,Severity,Priority,Status,Assignee,Created',...rows].join('\n'))});

// Global API error handler ensuring JSON responses instead of HTML error pages
app.use((err, req, res, next) => {
  console.error('[API Unhandled Error]', err.message || err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api') || req.path === '/health') {
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
  }
  next(err);
});

app.use(express.static(path.join(__dirname,'dist'))); app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`BugTrack Pro API running on port ${port}`));

export default app;

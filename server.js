import express from 'express';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeDataDir = process.env.VERCEL === '1' ? path.join(os.tmpdir(), 'bugtrack-pro') : __dirname;
fs.mkdirSync(runtimeDataDir, { recursive: true });
const app = express(); const uploadDir = path.join(runtimeDataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });
const analyzerUrl = process.env.ANALYZER_URL || 'http://127.0.0.1:5000';
const analyzerEndpoint = (pathName) => new URL(pathName.replace(/^\/+/, ''), `${analyzerUrl.replace(/\/+$/, '')}/`).toString();
const trustedOrigins = new Set((process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map(origin => origin.trim()).filter(Boolean));
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || trustedOrigins.has(origin)),
  credentials: true,
}));
app.use(express.json()); app.use('/uploads', express.static(uploadDir));
const sessionSecret = process.env.SESSION_SECRET || process.env.EMAIL_VERIFICATION_SECRET || crypto.randomBytes(32).toString('hex');
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
  const sessionCookie = parseCookies(req.headers.cookie).bugtrack_session || '';
  const session = readSession(sessionCookie);
  const user = session && db.data.users.find(candidate => candidate.id === session.userId);
  if (!user) {
    console.warn('Protected request rejected: invalid or expired session.', req.method, req.originalUrl);
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
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'BugTrack Pro API' }));
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
const verificationPepper = process.env.EMAIL_VERIFICATION_SECRET || crypto.randomBytes(32).toString('hex');
const passwordResetExpiryMinutes = Math.min(30, Math.max(15, Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES || 20)));
const passwordResetRequests = new Map();
class SmtpConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmtpConfigurationError';
    this.code = 'SMTP_NOT_CONFIGURED';
  }
}
class SmtpDeliveryError extends Error {
  constructor(cause) {
    super('The SMTP server could not deliver the email.');
    this.name = 'SmtpDeliveryError';
    this.code = 'SMTP_DELIVERY_FAILED';
    this.cause = cause;
  }
}
const smtpConfig = () => {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USER || process.env.SMTP_EMAIL)?.trim();
  const password = process.env.SMTP_PASSWORD;
  const from = (process.env.SMTP_FROM_EMAIL || process.env.SMTP_EMAIL || user)?.trim();
  const secure = String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true';
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !from) {
    throw new SmtpConfigurationError('Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM_EMAIL.');
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
  });
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
    await transporter.sendMail({
      from: config.from,
      to: email,
      subject: 'Verify your BugTrack Pro email',
      text: `Your BugTrack Pro verification code is ${code}. It expires in ${verificationExpiryMinutes} minutes.`,
    });
  } catch (error) {
    throw new SmtpDeliveryError(error);
  }
};
const sendPasswordResetEmail = async (email, token) => {
  const config = smtpConfig();
  const transporter = createSmtpTransporter();
  const resetBaseUrl = process.env.APP_URL || 'http://localhost:5173';
  const resetUrl = `${resetBaseUrl.replace(/\/$/, '')}/?resetToken=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from: config.from,
      to: email,
      subject: 'Reset your BugTrack Pro password',
      text: `Use this link to reset your BugTrack Pro password. It expires in ${passwordResetExpiryMinutes} minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    });
  } catch (error) {
    throw new SmtpDeliveryError(error);
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
app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const user = db.data.users.find((candidate) => typeof candidate.email === 'string' && candidate.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || !passwordMatches(password, user.passwordHash)) {
      console.warn(`Failed sign-in attempt for ${email.trim().toLowerCase()}`);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'Verify your email before signing in.', verificationRequired: true, email: user.email, maskedEmail: maskEmail(user.email) });
    }
    const sessionToken = signSession(user.id);
    const secure = process.env.VERCEL === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bugtrack_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetimeSeconds}${secure}`);
    res.json({ id: user.id, name: user.name, role: user.role, email: user.email });
  } catch (error) {
    console.error('Sign-in failed:', error);
    res.status(500).json({ error: 'Sign-in is temporarily unavailable. Please restart the application and try again.' });
  }
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'bugtrack_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
});
app.post('/api/password-reset/request', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const genericResponse = { message: 'If an account exists for this email, password reset instructions will be sent.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const nowMs = Date.now();
  const requestKey = `${req.ip}:${email}`;
  const lastRequestAt = passwordResetRequests.get(requestKey) || 0;
  if (nowMs - lastRequestAt < 60 * 1000) return res.status(202).json(genericResponse);
  passwordResetRequests.set(requestKey, nowMs);
  const user = db.data.users.find((candidate) => candidate.email.toLowerCase() === email);
  if (!user) return res.status(202).json(genericResponse);
  const token = crypto.randomBytes(32).toString('base64url');
  user.passwordResetTokenHash = hashResetToken(token);
  user.passwordResetExpiresAt = nowMs + passwordResetExpiryMinutes * 60 * 1000;
  await save();
  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (error) {
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    await save();
    console.error('Password reset email delivery failed:', error.code || error.message);
    if (error.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Password reset email is not configured on the server.', code: error.code });
    }
    return res.status(503).json({ error: 'The password reset email could not be delivered. Check the SMTP settings and try again.', code: error.code });
  }
  res.status(202).json(genericResponse);
});
app.post('/api/password-reset/validate', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const user = db.data.users.find((candidate) => candidate.passwordResetTokenHash === hashResetToken(token));
  if (!token || !user || !user.passwordResetExpiresAt || Date.now() > user.passwordResetExpiresAt) {
    return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
  }
  res.json({ valid: true });
});
app.post('/api/password-reset/complete', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.data.users.find((candidate) => candidate.passwordResetTokenHash === hashResetToken(token));
  if (!token || !user || !user.passwordResetExpiresAt || Date.now() > user.passwordResetExpiresAt) {
    return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  user.passwordHash = passwordHash(password);
  delete user.passwordResetTokenHash;
  delete user.passwordResetExpiresAt;
  await save();
  res.json({ reset: true, message: 'Your password has been reset successfully.' });
});
app.post('/api/register', async (req, res) => {
  const { name, email, password, role = 'Tester' } = req.body;
  if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const passwordError = passwordValidationError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const normalizedEmail = email.trim().toLowerCase();
  if (db.data.users.some((user) => user.email.toLowerCase() === normalizedEmail)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const safeRole = ['Developer', 'Tester', 'Viewer'].includes(role) ? role : 'Tester';
  const code = createVerificationCode();
  const user = { id: `usr_${crypto.randomUUID()}`, name: name.trim(), email: normalizedEmail, role: safeRole, passwordHash: passwordHash(password), emailVerified: false, verificationCodeHash: hashOtp(normalizedEmail, code), verificationExpiresAt: Date.now() + verificationExpiryMinutes * 60 * 1000, verificationAttempts: 0, verificationLastSentAt: Date.now(), verificationResends: [Date.now()], createdAt: new Date().toISOString() };
  db.data.users.push(user);
  await save();
  try {
    await sendVerificationEmail(user.email, code);
  } catch (error) {
    db.data.users = db.data.users.filter((candidate) => candidate !== user);
    await save();
    console.error('Verification email delivery failed:', error.code || error.message);
    if (error.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Verification email is not configured on the server.', code: error.code });
    }
    return res.status(503).json({ error: 'The verification email could not be delivered. Check the SMTP settings and try again.', code: error.code });
  }
  res.status(202).json({ verificationRequired: true, email: user.email, maskedEmail: maskEmail(user.email), expiresAt: user.verificationExpiresAt });
});
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
  res.json({ verified: true, message: 'Email verified successfully. Please sign in.' });
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
app.post('/api/bugs', requireAuth, async (req,res) => { if(!valid(req.body)) return res.status(400).json({error:'Required bug fields are missing.'}); const bug={...req.body,id:db.data.bugs.reduce((m,b)=>Math.max(m,b.id),0)+1,bug_key:`BUG-${db.data.nextBug++}`,user_id:req.user.id,is_demo:0,created_at:now(),updated_at:now()}; db.data.bugs.push(bug); db.data.activity.push({id:db.data.activity.length+1,bug_id:bug.id,user_id:req.user.id,type:'created',message:`${bug.bug_key} was reported`,actor:req.user.name,created_at:now()}); await save(); res.status(201).json(bug); });
app.put('/api/bugs/:id', requireAuth, async (req,res) => { if(!valid(req.body)) return res.status(400).json({error:'Required bug fields are missing.'}); const b=db.data.bugs.find(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(!b)return res.status(404).json({error:'Bug not found.'}); Object.assign(b,req.body,{user_id:req.user.id,updated_at:now()}); await save(); res.json(b); });
app.delete('/api/bugs/:id', requireAuth, async (req,res) => { const i=db.data.bugs.findIndex(x=>x.id===Number(req.params.id)&&x.user_id===req.user.id); if(i<0)return res.status(404).json({error:'Bug not found.'}); db.data.bugs.splice(i,1); db.data.activity = db.data.activity.filter(x => x.bug_id !== Number(req.params.id)); db.data.comments = db.data.comments.filter(x => x.bug_id !== Number(req.params.id)); await save(); res.status(204).end(); });
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
  const analysisId = req.path.split('/').filter(Boolean)[0];
  const analysis = db.data.analyses.find(item => item.id === analysisId && item.user_id === req.user.id);
  if (!analysis) return res.status(404).json({ error: 'Analysis report not found.' });
  try {
    const { host, ...forwardHeaders } = req.headers;
    const response = await fetch(analyzerEndpoint(req.originalUrl), {
      method: req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      duplex: 'half',
    });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    next(new Error('The analyzer service is unavailable.'));
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
app.use(express.static(path.join(__dirname,'dist'))); app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
const port = Number(process.env.PORT || 3000);
if (process.env.VERCEL !== '1') {
  app.listen(port,()=>console.log(`BugTrack Pro API running on port ${port}`));
}

export default app;

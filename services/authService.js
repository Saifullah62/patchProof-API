// services/authService.js
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken'); // <-- USE THE STANDARD LIBRARY
const VerificationCode = require('../models/VerificationCode');
const logger = require('../logger');
const { getSecret } = require('../secrets');

const MAX_VERIFICATION_ATTEMPTS = 5;
const JWT_SECRET = getSecret('JWT_SECRET');
if (!JWT_SECRET) {
  throw new Error('FATAL ERROR: JWT_SECRET is not defined in environment variables.');
}

class AuthService {
  constructor() {
    this.transporter = null;
    this._initEmailTransport();
  }

  _initEmailTransport() {
    try {
      const host = process.env.SMTP_HOST || null;
      const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
      const user = process.env.SMTP_USER || null;
      const pass = getSecret('SMTP_PASSWORD') || process.env.SMTP_PASS || null;
      if (host && (user || pass)) {
        this.transporter = nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: user && pass ? { user, pass } : undefined,
        });
        logger.info('AuthService: SMTP transport initialized.');
      } else {
        logger.warn('AuthService: SMTP config not set. Using mock sender.');
      }
    } catch (e) {
      logger.error({ message: 'AuthService: Failed to init SMTP', error: e.message });
      this.transporter = null;
    }
  }

  async _sendVerificationCodeEmail(identifier, code) {
    if (!this.transporter) {
      logger.info(`[AuthService MOCK] Send verification code ${code} to ${identifier}`);
      return;
    }
    const from = process.env.SMTP_FROM || 'PatchProof <noreply@patchproof.com>';
    try {
      await this.transporter.sendMail({
        from,
        to: identifier,
        subject: 'Your PatchProof Verification Code',
        text: `Your verification code is: ${code}. It expires in 15 minutes.`,
      });
      logger.info(`AuthService: Verification email sent to ${identifier}`);
    } catch (e) {
      logger.error({ message: 'AuthService: Failed to send verification email', error: e.message });
      throw new Error('Failed to send verification code');
    }
  }

  async requestVerification(identifier) {
    if (!identifier) throw new Error('Identifier is required.');

    const code = crypto.randomInt(100000, 999999).toString();

    await VerificationCode.findOneAndUpdate(
      { identifier },
      { code, attempts: 0, createdAt: Date.now() },
      { upsert: true, new: true }
    );

    // Send via email (production) or mock log (dev/test)
    await this._sendVerificationCodeEmail(identifier, code);

    return { success: true, message: 'Verification code generated and sent.', code };
  }

  async submitVerification(identifier, providedCode) {
    if (!identifier || !providedCode) throw new Error('Identifier and code are required.');

    const record = await VerificationCode.findOne({ identifier });
    if (!record) {
      return { success: false, message: 'Invalid or expired verification code.', reason: 'NotFoundOrExpired' };
    }

    if (record.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      await record.deleteOne();
      return { success: false, message: 'Too many attempts. Code invalidated.', reason: 'TooManyAttempts' };
    }

    if (record.code === providedCode) {
      await record.deleteOne();
      // --- MODIFIED LINE ---
      const token = jwt.sign({ identifier, method: 'identifier' }, JWT_SECRET, { expiresIn: '24h' });
      return { success: true, token };
    } else {
      record.attempts += 1;
      await record.save();
      const attemptsRemaining = MAX_VERIFICATION_ATTEMPTS - record.attempts;
      return { success: false, message: 'Invalid code.', reason: 'InvalidCode', attemptsRemaining };
    }
  }
}

module.exports = new AuthService();
// services/authService.js
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const VerificationCode = require('../models/VerificationCode');
const logger = require('../logger');
const { getSecret } = require('../secrets');
const jobService = require('./jobService');
const bcrypt = require('bcrypt');

const JWT_SECRET = getSecret('JWT_SECRET');
const BCRYPT_ROUNDS = Number(process.env.VERIFY_CODE_SALT_ROUNDS || 10);

class AuthService {
  constructor() {
    this.transporter = null;
    this.isReady = false;
  }

  /**
   * Initializes the email transport. Must be called at application startup.
   * If SMTP is configured, verifies the connection to fail fast on bad creds.
   * When SMTP is not configured, remains ready and uses mock sender.
   */
  async initialize() {
    if (this.isReady) return;
    try {
      const host = process.env.SMTP_HOST || getSecret('SMTP_HOST');
      const port = parseInt(process.env.SMTP_PORT || getSecret('SMTP_PORT'), 10);
      const user = process.env.SMTP_USER || getSecret('SMTP_USER');
      // Use SMTP_PASS, falling back to SMTP_PASSWORD for compatibility
      const pass = process.env.SMTP_PASS || getSecret('SMTP_PASS') || process.env.SMTP_PASSWORD || getSecret('SMTP_PASSWORD');

      if (host && user && pass) {
        this.transporter = nodemailer.createTransport({
          host, port, secure: port === 465, auth: { user, pass },
        });
        await this.transporter.verify();
        logger.info('AuthService: SMTP transport initialized and verified.');
        this.isReady = true;
      } else {
        logger.warn('AuthService: SMTP config not set. Email sending will be mocked.');
        this.isReady = true;
      }
    } catch (e) {
      logger.error({ message: 'AuthService: Failed to initialize SMTP transport', error: e.message });
      this.transporter = null;
      this.isReady = false;
    }
  }

  async _sendVerificationCodeEmail(identifier, code) {
    // If async jobs are enabled, enqueue and return
    if (jobService.isEnabled()) {
      await jobService.addEmailJob({
        to: identifier,
        subject: 'Your PatchProof Verification Code',
        text: `Your verification code is: ${code}. It expires in 15 minutes.`,
        html: `<p>Your verification code is: <b>${code}</b></p><p>If you did not request this, you can ignore this email.</p>`
      });
      logger.info('AuthService: queued verification email job');
      return true;
    }

    if (!this.transporter) {
      logger.info(`[AuthService MOCK] Send verification code ${code} to ${identifier}`);
      return true;
    }

    const fromAddress = process.env.EMAIL_FROM || getSecret('EMAIL_FROM');
    const envelopeFrom = process.env.SMTP_USER || getSecret('SMTP_USER');

    try {
      const info = await this.transporter.sendMail({
        from: fromAddress,
        to: identifier,
        subject: 'Your PatchProof Verification Code',
        text: `Your verification code is: ${code}. It expires in 15 minutes.`,
        html: `<p>Your verification code is: <b>${code}</b></p><p>If you did not request this, you can ignore this email.</p>`,
        // THIS IS THE CRUCIAL FIX:
        envelope: {
          from: envelopeFrom,
          to: identifier
        }
      });
      logger.info(`AuthService: Verification email sent to ${identifier}`, { messageId: info.messageId });
      return true;
    } catch (e) {
      logger.error({ message: 'AuthService: Failed to send verification email', error: e.message });
      throw new Error('Failed to send verification code via SMTP.');
    }
  }

  async requestVerification(identifier) {
    if (!identifier) throw new Error('Identifier is required.');
    if (process.env.NODE_ENV === 'production' && !this.isReady) {
      throw new Error('Authentication service is not ready.');
    }
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    await VerificationCode.findOneAndUpdate(
      { identifier },
      { codeHash, createdAt: new Date() },
      { upsert: true, new: true }
    );
    await this._sendVerificationCodeEmail(identifier, code);
    return {
      success: true,
      message: 'Verification code sent.',
      dev_code: process.env.NODE_ENV !== 'production' ? code : undefined,
    };
  }

  async submitVerification(identifier, providedCode) {
    if (!identifier || !providedCode) throw new Error('Identifier and code are required.');
    // Atomic: find and delete in a single step to prevent double-use race conditions
    const record = await VerificationCode.findOneAndDelete({ identifier });
    if (!record || !record.codeHash) {
      return { success: false, message: 'Invalid or expired verification code.', reason: 'NotFoundOrExpired' };
    }
    const isMatch = await bcrypt.compare(providedCode, record.codeHash);
    if (!isMatch) {
      return { success: false, message: 'Invalid code.', reason: 'InvalidCode' };
    }
    // Issue JWT with standard claims
    const payload = {
      sub: identifier,
      aud: 'patchproof:api',
      iss: 'patchproof:auth-service',
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
    return { success: true, token };
  }
}

module.exports = new AuthService();
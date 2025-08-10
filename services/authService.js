// services/authService.js
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const VerificationCode = require('../models/VerificationCode');
const logger = require('../logger');
const { getSecret } = require('../secrets');

const MAX_VERIFICATION_ATTEMPTS = 5;
const JWT_SECRET = getSecret('JWT_SECRET');

class AuthService {
  constructor() {
    this.transporter = null;
    this._initEmailTransport();
  }

  _initEmailTransport() {
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
    const code = crypto.randomInt(100000, 999999).toString();
    await VerificationCode.findOneAndUpdate(
      { identifier },
      { code, attempts: 0, createdAt: new Date() },
      { upsert: true, new: true }
    );
    await this._sendVerificationCodeEmail(identifier, code);
    return { success: true, message: 'Verification code sent.', code };
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
      const token = jwt.sign({ identifier }, JWT_SECRET, { expiresIn: '24h' });
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
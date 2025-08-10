// controllers/authController.js
const AuthService = require('../services/authService');
const logger = require('../logger');
const Joi = require('joi');

class AuthController {
  async requestVerification(req, res, next) {
    try {
      const schema = Joi.object({
        identifier: Joi.string().trim().min(3).max(320).required(),
      }).unknown(false);
      const { value, error } = schema.validate(req.body || {});
      if (error) {
        return res.status(400).json({ error: { message: 'Invalid request body', details: error.details.map(d => d.message) } });
      }
      const { identifier } = value;
      const result = await AuthService.requestVerification(identifier);
      let dev_code;
      if (process.env.NODE_ENV !== 'production' && result.code) dev_code = result.code;
      return res.status(200).json({ success: result.success, message: result.message, dev_code });
    } catch (err) { return next(err); }
  }

  async submitVerification(req, res, next) {
    try {
      const schema = Joi.object({
        identifier: Joi.string().trim().min(3).max(320).required(),
        code: Joi.string().trim().pattern(/^\d{6}$/).required(),
      }).unknown(false);
      const { value, error } = schema.validate(req.body || {});
      if (error) {
        return res.status(400).json({ error: { message: 'Invalid request body', details: error.details.map(d => d.message) } });
      }
      const { identifier, code } = value;
      const result = await AuthService.submitVerification(identifier, code);
      if (result.success) {
        (req.log || logger).info({ message: 'Verification successful, JWT issued', identifier });
        return res.status(200).json({ success: true, token: result.token });
      }
      (req.log || logger).warn({ message: 'Verification failed', identifier, reason: result.reason });
      return res.status(401).json({ success: false, message: result.message, reason: result.reason, attemptsRemaining: result.attemptsRemaining });
    } catch (err) { return next(err); }
  }
}

module.exports = new AuthController();

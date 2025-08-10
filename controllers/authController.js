// controllers/authController.js
const Joi = require('joi');
const AuthService = require('../services/authService');
const logger = require('../logger');

const requestSchema = Joi.object({
  identifier: Joi.string().min(3).max(320).required(),
});

const submitSchema = Joi.object({
  identifier: Joi.string().min(3).max(320).required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

class AuthController {
  async requestVerification(req, res, next) {
    try {
      const { error, value } = requestSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: { message: 'Validation failed', details: error.details.map(d => d.message) } });
      }

      const result = await AuthService.requestVerification(value.identifier);
      
      // For testing environments, return the code to simplify automation
      let dev_code;
      if (process.env.NODE_ENV === 'test' && result.code) {
        dev_code = result.code;
      }
      
      return res.status(200).json({ success: result.success, message: result.message, dev_code });
    } catch (err) {
      return next(err);
    }
  }

  async submitVerification(req, res, next) {
    try {
      const { error, value } = submitSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: { message: 'Validation failed', details: error.details.map(d => d.message) } });
      }
      
      const result = await AuthService.submitVerification(value.identifier, value.code);
      
      if (result.success) {
        (req.log || logger).info({ message: 'Verification successful, JWT issued', identifier: value.identifier });
        return res.status(200).json({ success: true, token: result.token });
      }
      
      (req.log || logger).warn({ message: 'Verification failed', identifier: value.identifier, reason: result.reason });
      return res.status(401).json({ success: false, message: result.message, reason: result.reason, attemptsRemaining: result.attemptsRemaining });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AuthController();

// middleware/validateRequest.js
// Generic Joi validation middleware (no field-specific normalization).

const Joi = require('joi');

/**
 * Creates an Express middleware that validates a request property (body, query, params)
 * against a Joi schema and strips unknown properties.
 * @param {Joi.Schema} schema The Joi schema to validate against.
 * @param {'body' | 'query' | 'params'} [source='body'] The request property to validate.
 */
function validateRequest(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const { error, value } = schema.validate(req[source] || {}, {
        abortEarly: false,
        stripUnknown: true,
      });
      if (error) {
        const details = error.details.map(d => ({ message: d.message, field: d.path.join('.') }));
        return res.status(400).json({ error: { message: 'Validation failed', details } });
      }
      req[source] = value;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = validateRequest;

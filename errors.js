// errors.js
// A centralized definition of custom error classes for the application.
// Each error includes a name and a corresponding HTTP status code for easy handling.

// --- General Application Errors ---

class AppError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.name = this.constructor.name;
      this.statusCode = statusCode;
      // Capturing the stack trace is useful for debugging.
      Error.captureStackTrace(this, this.constructor);
    }
  }
  
  class ConflictError extends AppError { constructor(message = 'Conflict') { super(message, 409); } }
  class NotFoundError extends AppError { constructor(message = 'Not Found') { super(message, 404); } }
  class ForbiddenError extends AppError { constructor(message = 'Forbidden') { super(message, 403); } }
  class DataInconsistencyError extends AppError { constructor(message = 'Data inconsistency') { super(message, 500); } }
  class ServiceUnavailableError extends AppError { constructor(message = 'Service Unavailable') { super(message, 503); } }
  class InsufficientFundsError extends AppError { constructor(message = 'Insufficient funds') { super(message, 400); } }
  
  
  // --- SVD-specific Errors ---
  
  class SvdError extends AppError { constructor(message, statusCode) { super(message, statusCode); } }
  class SvdReplayError extends SvdError { constructor(message = 'SVD replay detected') { super(message, 409); } }
  class SvdExpiredError extends SvdError { constructor(message = 'SVD challenge expired') { super(message, 400); } }
  class SvdInvalidSignatureError extends SvdError { constructor(message = 'SVD signature invalid') { super(message, 401); } }
  class SvdBadChallengeError extends SvdError { constructor(message = 'SVD challenge mismatch') { super(message, 400); } }
  class SvdNoPmcError extends SvdError { constructor(message = 'User has no registered PMC') { super(message, 400); } }
  
  module.exports = {
      AppError,
      ConflictError,
      NotFoundError,
      ForbiddenError,
      DataInconsistencyError,
      ServiceUnavailableError,
      InsufficientFundsError,
      SvdError,
      SvdReplayError,
      SvdExpiredError,
      SvdInvalidSignatureError,
      SvdBadChallengeError,
      SvdNoPmcError,
  };
  
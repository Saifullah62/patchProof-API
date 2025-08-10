// emailStub.js
// Production email sending using Nodemailer with SMTP transport
// Required env vars:
// - SMTP_HOST
// - SMTP_PORT (number)
// - SMTP_USER
// - SMTP_PASS
// - EMAIL_FROM (display/email, e.g. 'PatchProof <no-reply@proofpatch.com>')

const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  NODE_ENV
} = process.env;

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  // In test environment, stub out mail sending silently
  if (NODE_ENV === 'test') {
    transporter = {
      sendMail: async () => ({ accepted: [], rejected: [], messageId: 'test-message-id' })
    };
    return transporter;
  }
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
    throw new Error('FATAL ERROR: Email configuration missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM.');
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true for 465, false for others
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendVerificationEmail(to, codeOrLink) {
  const t = getTransporter();
  const subject = 'Your PatchProof verification code';
  const text = `Your verification code is: ${codeOrLink}\n\nIf you did not request this, you can ignore this email.`;
  const html = `<p>Your verification code is: <b>${codeOrLink}</b></p><p>If you did not request this, you can ignore this email.</p>`;
  const info = await t.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });
  return Boolean(info && info.messageId);
}

module.exports = { sendVerificationEmail };

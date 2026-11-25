const nodemailer = require('nodemailer');
const { nowIso } = require('./dates');

let transport = null;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/**
 * Registra o e-mail na caixa de saída e envia via SMTP quando configurado.
 * Sem SMTP, a TI vê as mensagens em Administração > E-mails enviados.
 */
async function sendMail(db, { to, subject, text }) {
  const info = db
    .prepare('INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)')
    .run(to, subject, text, nowIso());
  const t = getTransport();
  if (!t) return { delivered: false, id: info.lastInsertRowid };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    db.prepare('UPDATE email_outbox SET delivered = 1 WHERE id = ?').run(info.lastInsertRowid);
    return { delivered: true, id: info.lastInsertRowid };
  } catch (err) {
    db.prepare('UPDATE email_outbox SET error = ? WHERE id = ?').run(String(err.message).slice(0, 500), info.lastInsertRowid);
    console.error('[e-mail] falha ao enviar:', err.message);
    return { delivered: false, id: info.lastInsertRowid, error: err.message };
  }
}

module.exports = { sendMail, smtpConfigured: () => !!process.env.SMTP_HOST };

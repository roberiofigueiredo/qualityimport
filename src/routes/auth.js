const express = require('express');
const auth = require('../lib/auth');
const { audit } = require('../lib/audit');
const { sendMail } = require('../lib/mailer');
const { nowIso } = require('../lib/dates');

const router = express.Router();

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function safeReturn(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/intranet';
}

function cookieOpts(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || req.secure,
    maxAge: auth.SESSION_DAYS * 86400000,
    path: '/',
  };
}

router.get('/entrar', (req, res) => {
  if (req.user) return res.redirect(safeReturn(req.query.volta));
  res.render('auth/entrar', { title: 'Área do Colaborador', email: '', volta: req.query.volta || '', error: null });
});

router.post('/entrar', (req, res) => {
  const db = req.app.locals.db;
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.senha || '');
  const volta = req.body.volta || '';
  const key = `${req.ip}|${email}`;
  const fail = (msg, status = 401) => res.status(status).render('auth/entrar', { title: 'Área do Colaborador', email, volta, error: msg });

  if (auth.tooManyAttempts(key)) return fail('Muitas tentativas. Aguarde 15 minutos e tente novamente.', 429);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.registerFailure(key);
    return fail('E-mail ou senha incorretos.');
  }
  if (user.status === 'desativado') return fail('Esta conta está desativada. Procure a equipe de TI.', 403);
  if (user.status !== 'ativo') return fail('O acesso desta conta ainda não foi liberado. Use o link do convite enviado por e-mail.', 403);

  auth.clearFailures(key);
  const token = auth.createSession(db, user.id, req.get('user-agent'));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  audit(db, user.id, 'login', 'usuario', user.id);
  res.cookie(auth.SESSION_COOKIE, token, cookieOpts(req));
  res.redirect(safeReturn(volta));
});

router.post('/sair', (req, res) => {
  const db = req.app.locals.db;
  if (req.user) audit(db, req.user.id, 'logout', 'usuario', req.user.id);
  auth.destroySession(db, req.cookies[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
  res.redirect('/entrar');
});

router.get('/esqueci-senha', (req, res) => {
  res.render('auth/esqueci', { title: 'Recuperar senha', sent: false, email: '' });
});

router.post('/esqueci-senha', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'ativo'").get(email);
    if (user) {
      const token = auth.createPasswordToken(db, user.id, 'redefinicao');
      await sendMail(db, {
        to: user.email,
        subject: 'Redefinição de senha - Intranet Quality Import Peças',
        text: `Olá, ${user.name}.\n\nRecebemos um pedido para redefinir a sua senha da intranet.\nPara criar uma nova senha, acesse o link abaixo (válido por 2 horas):\n\n${baseUrl(req)}/definir-senha/${token}\n\nSe você não fez este pedido, ignore este e-mail.`,
      });
      audit(db, user.id, 'senha.redefinicao_solicitada', 'usuario', user.id);
    }
    // Mesma resposta para e-mails existentes ou não (não revela quem tem conta)
    res.render('auth/esqueci', { title: 'Recuperar senha', sent: true, email });
  } catch (e) {
    next(e);
  }
});

router.get('/definir-senha/:token', (req, res) => {
  const t = auth.findPasswordToken(req.app.locals.db, req.params.token);
  if (!t) return res.status(410).render('auth/definir-senha', { title: 'Link inválido', invalid: true, t: null, error: null });
  res.render('auth/definir-senha', { title: t.kind === 'convite' ? 'Ativar acesso' : 'Nova senha', invalid: false, t, error: null });
});

router.post('/definir-senha/:token', (req, res) => {
  const db = req.app.locals.db;
  const t = auth.findPasswordToken(db, req.params.token);
  if (!t) return res.status(410).render('auth/definir-senha', { title: 'Link inválido', invalid: true, t: null, error: null });
  const pw = String(req.body.senha || '');
  const problem = auth.passwordProblem(pw) || (pw !== req.body.confirmacao ? 'As senhas não conferem.' : null);
  if (problem) return res.status(400).render('auth/definir-senha', { title: 'Definir senha', invalid: false, t, error: problem });

  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, status = CASE WHEN status = 'convidado' THEN 'ativo' ELSE status END WHERE id = ?").run(
      auth.hashPassword(pw),
      t.user_id
    );
    db.prepare('UPDATE password_tokens SET used_at = ? WHERE id = ?').run(nowIso(), t.id);
    auth.destroyUserSessions(db, t.user_id); // nova senha encerra sessões antigas
  })();
  audit(db, t.user_id, 'senha.definida', 'usuario', t.user_id);
  res.flash('sucesso', 'Senha definida com sucesso. Entre com o seu e-mail e a nova senha.');
  res.redirect('/entrar');
});

module.exports = router;
module.exports.baseUrl = baseUrl;

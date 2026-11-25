const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { openDb, getSettings } = require('./db');
const auth = require('./lib/auth');
const dates = require('./lib/dates');
const html = require('./lib/html');
const { can, ROLE_LABELS } = require('./lib/permissions');
const { humanSize } = require('./lib/uploads');
const { checkCsrf } = require('./routes/guards');

function createApp({ db } = {}) {
  db = db || openDb();
  const app = express();
  app.locals.db = db;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src https://www.google.com; frame-ancestors 'self'; form-action 'self' https://wa.me https://api.whatsapp.com",
    });
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  // Sessão: carregada do banco a cada requisição. Conta desativada perde o acesso imediatamente.
  app.use((req, res, next) => {
    const token = req.cookies[auth.SESSION_COOKIE];
    const s = auth.loadSession(db, token);
    if (s) {
      req.user = s.user;
      req.session = s;
    } else if (token) {
      res.clearCookie(auth.SESSION_COOKIE);
    }
    next();
  });

  // Variáveis e funções disponíveis em todas as telas
  app.use((req, res, next) => {
    const settings = getSettings(db);
    Object.assign(res.locals, {
      user: req.user || null,
      csrf: req.session ? req.session.csrf : '',
      settings,
      path: req.path,
      query: req.query,
      can: (cap) => can(req.user, cap),
      ROLE_LABELS,
      d: dates,
      h: html,
      humanSize,
      PENDENTE: 'Pendente de cadastro',
      flash: req.cookies.qi_flash ? safeJson(req.cookies.qi_flash) : null,
    });
    if (req.cookies.qi_flash) res.clearCookie('qi_flash');
    res.flash = (type, message) => res.cookie('qi_flash', JSON.stringify({ type, message }), { httpOnly: true, sameSite: 'lax', maxAge: 60000 });
    next();
  });

  // Proteção CSRF para formulários enviados com sessão ativa (multipart é verificado na própria rota)
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.session) return next();
    if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
    return checkCsrf(req, res, next);
  });

  app.use(require('./routes/public'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/files'));
  app.use('/intranet', require('./routes/intranet'));
  app.use('/painel', require('./routes/painel'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('erro', { title: 'Página não encontrada', status: 404, message: 'A página que você procurou não existe ou não está disponível para o seu perfil.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).render('erro', { title: 'Arquivo muito grande', status: 413, message: 'Cada arquivo pode ter no máximo 15 MB.' });
    }
    console.error(err);
    res.status(500).render('erro', { title: 'Erro inesperado', status: 500, message: 'Ocorreu um erro ao processar sua solicitação. Tente novamente.' });
  });

  return app;
}

function safeJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

module.exports = { createApp };

const { can } = require('../lib/permissions');

function requireLogin(req, res, next) {
  if (req.user) return next();
  const volta = encodeURIComponent(req.originalUrl);
  return res.redirect(`/entrar?volta=${volta}`);
}

function requireCap(cap) {
  return [
    requireLogin,
    (req, res, next) => {
      if (can(req.user, cap)) return next();
      return res.status(403).render('erro', {
        title: 'Acesso não permitido',
        status: 403,
        message: 'O seu perfil não tem permissão para acessar esta área.',
      });
    },
  ];
}

function notFound(res) {
  return res.status(404).render('erro', {
    title: 'Conteúdo não encontrado',
    status: 404,
    message: 'Este conteúdo não existe, saiu de circulação ou não é destinado ao seu público.',
  });
}

function intParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function checkCsrf(req, res, next) {
  if (req.session && req.body && req.body._csrf && req.body._csrf === req.session.csrf) return next();
  return res.status(403).render('erro', { title: 'Sessão expirada', status: 403, message: 'O formulário expirou. Volte, atualize a página e tente novamente.' });
}

module.exports = { requireLogin, requireCap, notFound, intParam, checkCsrf };

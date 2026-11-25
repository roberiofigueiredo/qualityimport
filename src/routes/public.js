const express = require('express');
const { waLink } = require('../lib/html');
const { intParam } = require('./guards');

const router = express.Router();

function publicBranches(db) {
  return db.prepare('SELECT * FROM branches WHERE active = 1 AND show_on_site = 1 ORDER BY sort_order, name').all();
}

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const branches = publicBranches(db);
  const cities = [...new Set(branches.map((b) => (b.city || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const lines = db.prepare('SELECT * FROM product_lines WHERE active = 1 ORDER BY sort_order, name').all();
  const q = (req.query.busca || '').trim().toLowerCase();
  const city = (req.query.cidade || '').trim();
  const filtered = branches.filter((b) => {
    if (city && (b.city || '').trim() !== city) return false;
    if (q && ![b.name, b.city, b.address].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  res.render('public/home', {
    title: res.locals.settings.company_name,
    branches: filtered,
    totalBranches: branches.length,
    cities,
    lines,
    busca: req.query.busca || '',
    cidade: city,
    waGeneral: waLink(res.locals.settings.whatsapp_number, res.locals.settings.whatsapp_message),
  });
});

/** Canal de orçamento: redireciona para o WhatsApp da filial (ou o geral). */
router.get('/orcamento', (req, res) => {
  const db = req.app.locals.db;
  const s = res.locals.settings;
  const id = intParam(req.query.filial);
  const branch = id ? db.prepare('SELECT * FROM branches WHERE id = ? AND active = 1 AND show_on_site = 1').get(id) : null;
  const number = (branch && branch.whatsapp) || s.whatsapp_number;
  const message = branch ? `${s.whatsapp_message} (Loja: ${branch.name})` : s.whatsapp_message;
  const link = waLink(number, message);
  if (link) return res.redirect(302, link);
  res.status(200).render('public/orcamento-pendente', { title: 'Solicitar orçamento', branch, branches: publicBranches(db) });
});

module.exports = router;

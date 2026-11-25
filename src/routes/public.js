const express = require('express');
const { waLink, safeUrl } = require('../lib/html');
const { parseLines } = require('../db');
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
  const s = res.locals.settings;
  const withDelivery = branches
    .map((b) => ({ ...b, regions: parseLines(b.delivery_regions, 4), embed: safeUrl(b.map_embed).startsWith('https://www.google.com/maps/embed') ? b.map_embed : '' }));
  res.render('public/home', {
    differentials: parseLines(s.differentials, 1).map((l) => l[0]),
    stats: parseLines(s.stats, 2),
    deliveryBranches: withDelivery.filter((b) => b.regions.length),
    embeds: Object.fromEntries(withDelivery.map((b) => [b.id, b.embed])),
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

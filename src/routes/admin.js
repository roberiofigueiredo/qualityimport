// Administração de acessos e cadastros — exclusivo do perfil Administrador de TI.
const express = require('express');
const auth = require('../lib/auth');
const { audit, ACTION_LABELS } = require('../lib/audit');
const { sendMail, smtpConfigured } = require('../lib/mailer');
const { ROLES, ROLE_LABELS } = require('../lib/permissions');
const { upload, registerFile } = require('../lib/uploads');
const { setSetting, getSettings, DEFAULT_SETTINGS } = require('../db');
const { nowIso, localToIso, parseDateInput } = require('../lib/dates');
const { safeUrl } = require('../lib/html');
const { requireCap, notFound, intParam, checkCsrf } = require('./guards');
const { baseUrl } = require('./auth');

const router = express.Router();
router.use(requireCap('admin'));

const STATUS_LABELS = { convidado: 'Convite pendente', ativo: 'Ativo', desativado: 'Desativado' };

function lookups(db) {
  return {
    branches: db.prepare('SELECT id, name, active FROM branches ORDER BY sort_order, name').all(),
    sectors: db.prepare('SELECT id, name, active FROM sectors ORDER BY name').all(),
  };
}

router.get('/', (req, res) => res.redirect('/admin/usuarios'));

// ---------------------------------------------------------------- Usuários
router.get('/usuarios', (req, res) => {
  const db = req.app.locals.db;
  const f = {
    q: String(req.query.q || '').trim(),
    perfil: ROLES.includes(req.query.perfil) ? req.query.perfil : '',
    filial: intParam(req.query.filial) || '',
    setor: intParam(req.query.setor) || '',
    situacao: STATUS_LABELS[req.query.situacao] ? req.query.situacao : '',
  };
  const where = ['1=1'];
  const p = {};
  if (f.q) {
    where.push('(u.name LIKE @q OR u.email LIKE @q)');
    p.q = `%${f.q}%`;
  }
  if (f.perfil) (where.push('u.role = @perfil'), (p.perfil = f.perfil));
  if (f.filial) (where.push('u.branch_id = @filial'), (p.filial = f.filial));
  if (f.setor) (where.push('u.sector_id = @setor'), (p.setor = f.setor));
  if (f.situacao) (where.push('u.status = @situacao'), (p.situacao = f.situacao));
  const users = db
    .prepare(
      `SELECT u.*, b.name branch_name, s.name sector_name FROM users u
         LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN sectors s ON s.id = u.sector_id
        WHERE ${where.join(' AND ')} ORDER BY u.status = 'desativado', u.name`
    )
    .all(p);
  res.render('admin/usuarios', { title: 'Usuários', users, f, STATUS_LABELS, ...lookups(db) });
});

function validateUser(db, body, existingId) {
  const v = {
    name: String(body.nome || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    role: body.perfil,
    branch_id: intParam(body.filial),
    sector_id: intParam(body.setor),
  };
  let error = null;
  if (!v.name) error = 'Informe o nome.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) error = 'Informe um e-mail válido.';
  else if (!ROLES.includes(v.role)) error = 'Selecione o perfil de permissão.';
  else if (!v.branch_id || !db.prepare('SELECT 1 FROM branches WHERE id = ?').get(v.branch_id)) error = 'Selecione a filial.';
  else if (!v.sector_id || !db.prepare('SELECT 1 FROM sectors WHERE id = ?').get(v.sector_id)) error = 'Selecione o setor.';
  else {
    const dup = db.prepare('SELECT id FROM users WHERE email = ?').get(v.email);
    if (dup && dup.id !== existingId) error = 'Já existe uma conta com este e-mail.';
  }
  return { v, error };
}

async function sendInvite(req, db, user) {
  const token = auth.createPasswordToken(db, user.id, 'convite');
  const link = `${baseUrl(req)}/definir-senha/${token}`;
  await sendMail(db, {
    to: user.email,
    subject: 'Seu acesso à intranet Quality Import Peças',
    text: `Olá, ${user.name}.\n\nA equipe de TI liberou o seu acesso à intranet da Quality Import Peças.\nPara ativar sua conta e criar sua senha, acesse o link abaixo (válido por 72 horas):\n\n${link}\n\nDepois disso, entre pelo botão "Área do Colaborador" no site, usando este e-mail.`,
  });
  audit(db, req.user.id, 'usuario.convite_enviado', 'usuario', user.id);
  return link;
}

async function sendReset(req, db, user) {
  const token = auth.createPasswordToken(db, user.id, 'redefinicao');
  const link = `${baseUrl(req)}/definir-senha/${token}`;
  await sendMail(db, {
    to: user.email,
    subject: 'Redefinição de senha - Intranet Quality Import Peças',
    text: `Olá, ${user.name}.\n\nA equipe de TI iniciou a redefinição da sua senha da intranet.\nPara criar uma nova senha, acesse o link abaixo (válido por 2 horas):\n\n${link}`,
  });
  audit(db, req.user.id, 'usuario.redefinicao_iniciada', 'usuario', user.id);
  return link;
}

function linkNotice(res, link, kind) {
  // Sem SMTP configurado, a TI recebe o link para repassar ao colaborador.
  if (!smtpConfigured()) res.cookie('qi_link', JSON.stringify({ link, kind }), { httpOnly: true, sameSite: 'lax', maxAge: 120000 });
}

router.get('/usuarios/novo', (req, res) => {
  const db = req.app.locals.db;
  res.render('admin/usuario-form', { title: 'Cadastrar colaborador', target: null, form: { perfil: 'colaborador', convite: true }, error: null, ROLE_LABELS, STATUS_LABELS, ...lookups(db) });
});

router.post('/usuarios', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { v, error } = validateUser(db, req.body);
    if (error) {
      return res.status(400).render('admin/usuario-form', { title: 'Cadastrar colaborador', target: null, form: { ...req.body, convite: req.body.convite === '1' }, error, ROLE_LABELS, STATUS_LABELS, ...lookups(db) });
    }
    const id = db
      .prepare("INSERT INTO users (name, email, role, branch_id, sector_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'convidado', ?)")
      .run(v.name, v.email, v.role, v.branch_id, v.sector_id, nowIso()).lastInsertRowid;
    audit(db, req.user.id, 'usuario.criado', 'usuario', id, { email: v.email, perfil: v.role, filial: v.branch_id, setor: v.sector_id });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (req.body.convite === '1') {
      linkNotice(res, await sendInvite(req, db, user), 'convite');
      res.flash('sucesso', `Colaborador cadastrado e convite enviado para ${user.email}.`);
    } else {
      res.flash('sucesso', 'Colaborador cadastrado. Envie o convite quando quiser liberar o acesso.');
    }
    res.redirect(`/admin/usuarios/${id}`);
  } catch (e) {
    next(e);
  }
});

router.get('/usuarios/:id', (req, res) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
  if (!target) return notFound(res);
  let linkInfo = null;
  if (req.cookies.qi_link) {
    try {
      linkInfo = JSON.parse(req.cookies.qi_link);
    } catch {}
    res.clearCookie('qi_link');
  }
  const history = db
    .prepare(
      `SELECT l.*, u.name actor FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE (l.entity_type = 'usuario' AND l.entity_id = ?) OR l.user_id = ? ORDER BY l.id DESC LIMIT 30`
    )
    .all(String(target.id), target.id);
  const sessions = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(target.id).c;
  res.render('admin/usuario-form', {
    title: target.name,
    target,
    form: { nome: target.name, email: target.email, perfil: target.role, filial: target.branch_id, setor: target.sector_id },
    error: null,
    linkInfo,
    history,
    sessions,
    ACTION_LABELS,
    ROLE_LABELS,
    STATUS_LABELS,
    ...lookups(db),
  });
});

function activeAdmins(db, exceptId) {
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'ti' AND status = 'ativo' AND id != ?").get(exceptId).c;
}

router.post('/usuarios/:id', (req, res) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
  if (!target) return notFound(res);
  const { v, error: err0 } = validateUser(db, req.body, target.id);
  let error = err0;
  if (!error && target.role === 'ti' && v.role !== 'ti' && activeAdmins(db, target.id) === 0) {
    error = 'Não é possível remover o perfil do único Administrador de TI ativo.';
  }
  if (error) {
    return res.status(400).render('admin/usuario-form', {
      title: target.name,
      target,
      form: req.body,
      error,
      history: [],
      sessions: 0,
      ACTION_LABELS,
      ROLE_LABELS,
      STATUS_LABELS,
      ...lookups(db),
    });
  }
  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, branch_id = ?, sector_id = ? WHERE id = ?').run(v.name, v.email, v.role, v.branch_id, v.sector_id, target.id);
  if (v.role !== target.role) {
    audit(db, req.user.id, 'usuario.perfil_alterado', 'usuario', target.id, { de: ROLE_LABELS[target.role], para: ROLE_LABELS[v.role] });
  }
  const changed = {};
  if (v.name !== target.name) changed.nome = { de: target.name, para: v.name };
  if (v.email !== target.email) changed.email = { de: target.email, para: v.email };
  if (v.branch_id !== target.branch_id) changed.filial = { de: target.branch_id, para: v.branch_id };
  if (v.sector_id !== target.sector_id) changed.setor = { de: target.sector_id, para: v.sector_id };
  if (Object.keys(changed).length) audit(db, req.user.id, 'usuario.dados_alterados', 'usuario', target.id, changed);
  res.flash('sucesso', 'Dados atualizados.');
  res.redirect(`/admin/usuarios/${target.id}`);
});

router.post('/usuarios/:id/convite', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
    if (!target) return notFound(res);
    if (target.status !== 'convidado') {
      res.flash('erro', 'Esta conta já está ativa. Use “Iniciar redefinição de senha”.');
      return res.redirect(`/admin/usuarios/${target.id}`);
    }
    linkNotice(res, await sendInvite(req, db, target), 'convite');
    res.flash('sucesso', `Convite enviado para ${target.email}.`);
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (e) {
    next(e);
  }
});

router.post('/usuarios/:id/redefinir-senha', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
    if (!target) return notFound(res);
    if (target.status !== 'ativo') {
      res.flash('erro', 'A redefinição de senha só pode ser iniciada para contas ativas.');
      return res.redirect(`/admin/usuarios/${target.id}`);
    }
    linkNotice(res, await sendReset(req, db, target), 'redefinicao');
    res.flash('sucesso', `Link de redefinição enviado para ${target.email}.`);
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (e) {
    next(e);
  }
});

router.get('/usuarios/:id/desativar', (req, res) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
  if (!target) return notFound(res);
  res.render('painel/confirmar', {
    title: 'Desativar conta',
    heading: `Desativar a conta de ${target.name}?`,
    message:
      'A pessoa perderá o acesso imediatamente, inclusive em sessões que estiverem abertas. As publicações e o histórico de ações dela serão preservados. A conta pode ser reativada depois.',
    action: `/admin/usuarios/${target.id}/desativar`,
    confirmLabel: 'Sim, desativar conta',
    back: `/admin/usuarios/${target.id}`,
    extraField: null,
  });
});

router.post('/usuarios/:id/desativar', (req, res) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
  if (!target) return notFound(res);
  if (req.body.confirmar !== 'sim') return res.redirect(`/admin/usuarios/${target.id}/desativar`);
  if (target.id === req.user.id) {
    res.flash('erro', 'Você não pode desativar a sua própria conta.');
    return res.redirect(`/admin/usuarios/${target.id}`);
  }
  if (target.role === 'ti' && activeAdmins(db, target.id) === 0) {
    res.flash('erro', 'Não é possível desativar o único Administrador de TI ativo.');
    return res.redirect(`/admin/usuarios/${target.id}`);
  }
  let ended = 0;
  db.transaction(() => {
    db.prepare("UPDATE users SET status = 'desativado', deactivated_at = ? WHERE id = ?").run(nowIso(), target.id);
    ended = auth.destroyUserSessions(db, target.id);
    db.prepare('UPDATE password_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowIso(), target.id);
  })();
  audit(db, req.user.id, 'usuario.desativado', 'usuario', target.id, { sessoes_encerradas: ended });
  res.flash('sucesso', `Conta desativada. ${ended} sessão(ões) ativa(s) encerrada(s).`);
  res.redirect(`/admin/usuarios/${target.id}`);
});

router.post('/usuarios/:id/reativar', (req, res) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(intParam(req.params.id));
  if (!target) return notFound(res);
  const status = target.password_hash ? 'ativo' : 'convidado';
  db.prepare('UPDATE users SET status = ?, deactivated_at = NULL WHERE id = ?').run(status, target.id);
  audit(db, req.user.id, 'usuario.reativado', 'usuario', target.id);
  res.flash('sucesso', status === 'ativo' ? 'Conta reativada.' : 'Conta reativada. Envie um novo convite para a pessoa criar a senha.');
  res.redirect(`/admin/usuarios/${target.id}`);
});

// ---------------------------------------------------------------- Filiais
router.get('/filiais', (req, res) => {
  const db = req.app.locals.db;
  const rows = db
    .prepare('SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.status != \'desativado\') users FROM branches b ORDER BY b.sort_order, b.name')
    .all();
  res.render('admin/filiais', { title: 'Filiais', rows });
});

const BRANCH_FIELDS = ['name', 'city', 'address', 'phone', 'whatsapp', 'hours', 'map_url', 'map_embed', 'lat', 'lng', 'delivery_start', 'delivery_regions'];
function branchFromBody(b) {
  return {
    name: String(b.nome || '').trim(),
    city: String(b.cidade || '').trim(),
    address: String(b.endereco || '').trim(),
    phone: String(b.telefone || '').trim(),
    whatsapp: String(b.whatsapp || '').trim(),
    hours: String(b.horario || '').trim(),
    map_url: safeUrl(b.mapa),
    map_embed: String(b.mapa_embed || '').trim().startsWith('https://www.google.com/maps/embed') ? String(b.mapa_embed).trim() : '',
    lat: b.lat === '' || b.lat == null || isNaN(Number(String(b.lat).replace(',', '.'))) ? null : Number(String(b.lat).replace(',', '.')),
    lng: b.lng === '' || b.lng == null || isNaN(Number(String(b.lng).replace(',', '.'))) ? null : Number(String(b.lng).replace(',', '.')),
    delivery_start: String(b.entrega_inicio || '').trim(),
    delivery_regions: String(b.entrega_regioes || '').trim(),
    show_on_site: b.exibir_no_site === '1' ? 1 : 0,
    active: b.ativa === '1' ? 1 : 0,
    sort_order: Number(b.ordem) || 0,
  };
}

router.get('/filiais/nova', (req, res) => res.render('admin/filial-form', { title: 'Nova filial', row: { show_on_site: 1, active: 1, sort_order: 0 }, error: null }));
router.get('/filiais/:id', (req, res) => {
  const row = req.app.locals.db.prepare('SELECT * FROM branches WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  res.render('admin/filial-form', { title: row.name, row, error: null });
});

function saveBranch(req, res) {
  const db = req.app.locals.db;
  const id = req.params.id ? intParam(req.params.id) : null;
  const existing = id ? db.prepare('SELECT * FROM branches WHERE id = ?').get(id) : null;
  if (id && !existing) return notFound(res);
  const v = branchFromBody(req.body);
  if (!v.name) return res.status(400).render('admin/filial-form', { title: 'Filial', row: { ...existing, ...v }, error: 'Informe o nome da filial.' });
  if (req.body.mapa && !v.map_url) return res.status(400).render('admin/filial-form', { title: 'Filial', row: { ...existing, ...v }, error: 'O link do mapa deve começar com https://' });
  let bid = id;
  if (existing) {
    db.prepare(
      'UPDATE branches SET name=@name, city=@city, address=@address, phone=@phone, whatsapp=@whatsapp, hours=@hours, map_url=@map_url, map_embed=@map_embed, lat=@lat, lng=@lng, delivery_start=@delivery_start, delivery_regions=@delivery_regions, show_on_site=@show_on_site, active=@active, sort_order=@sort_order WHERE id=@id'
    ).run({ ...v, id });
    const changed = Object.fromEntries([...BRANCH_FIELDS, 'show_on_site', 'active'].filter((k) => (existing[k] ?? '') !== (v[k] ?? '')).map((k) => [k, { de: existing[k], para: v[k] }]));
    audit(db, req.user.id, 'filial.alterada', 'filial', id, changed);
  } else {
    bid = db
      .prepare(
        'INSERT INTO branches (name, city, address, phone, whatsapp, hours, map_url, map_embed, lat, lng, delivery_start, delivery_regions, show_on_site, active, sort_order, created_at) VALUES (@name, @city, @address, @phone, @whatsapp, @hours, @map_url, @map_embed, @lat, @lng, @delivery_start, @delivery_regions, @show_on_site, @active, @sort_order, @now)'
      )
      .run({ ...v, now: nowIso() }).lastInsertRowid;
    audit(db, req.user.id, 'filial.criada', 'filial', bid, { nome: v.name });
  }
  res.flash('sucesso', 'Filial salva.');
  res.redirect('/admin/filiais');
}
router.post('/filiais', saveBranch);
router.post('/filiais/:id', saveBranch);

// ---------------------------------------------------------------- Setores, categorias e linhas (cadastros simples)
const SIMPLE = {
  setores: { table: 'sectors', title: 'Setores', singular: 'setor', audit: 'setor', hint: 'Usados no cadastro de colaboradores e no público-alvo dos conteúdos.' },
  categorias: { table: 'categories', title: 'Categorias de informativos', singular: 'categoria', audit: 'categoria', hint: 'Exemplos: RH, TI, Treinamentos, Campanhas internas, Manutenção programada.' },
};
for (const [slug, cfg] of Object.entries(SIMPLE)) {
  router.get(`/${slug}`, (req, res) => {
    const rows = req.app.locals.db.prepare(`SELECT * FROM ${cfg.table} ORDER BY active DESC, name`).all();
    res.render('admin/simples', { title: cfg.title, rows, cfg, slug, error: null });
  });
  router.post(`/${slug}`, (req, res) => {
    const db = req.app.locals.db;
    const name = String(req.body.nome || '').trim();
    if (!name) return res.redirect(`/admin/${slug}`);
    try {
      const id = db.prepare(`INSERT INTO ${cfg.table} (name) VALUES (?)`).run(name).lastInsertRowid;
      audit(db, req.user.id, `${cfg.audit}.${cfg.audit === 'setor' ? 'criado' : 'criada'}`, cfg.audit, id, { nome: name });
      res.flash('sucesso', `${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} cadastrado(a).`);
    } catch {
      res.flash('erro', 'Já existe um cadastro com esse nome.');
    }
    res.redirect(`/admin/${slug}`);
  });
  router.post(`/${slug}/:id`, (req, res) => {
    const db = req.app.locals.db;
    const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(intParam(req.params.id));
    if (!row) return notFound(res);
    const name = String(req.body.nome || row.name).trim();
    const active = req.body.ativo === '1' ? 1 : 0;
    try {
      db.prepare(`UPDATE ${cfg.table} SET name = ?, active = ? WHERE id = ?`).run(name, active, row.id);
      audit(db, req.user.id, `${cfg.audit}.${cfg.audit === 'setor' ? 'alterado' : 'alterada'}`, cfg.audit, row.id, { nome: { de: row.name, para: name }, ativo: { de: row.active, para: active } });
      res.flash('sucesso', 'Alteração salva.');
    } catch {
      res.flash('erro', 'Já existe um cadastro com esse nome.');
    }
    res.redirect(`/admin/${slug}`);
  });
}

router.get('/linhas', (req, res) => {
  const rows = req.app.locals.db.prepare('SELECT * FROM product_lines ORDER BY sort_order, name').all();
  res.render('admin/linhas', { title: 'Linhas de autopeças', rows });
});
router.post('/linhas', (req, res) => {
  const db = req.app.locals.db;
  const id = intParam(req.body.id);
  const v = {
    name: String(req.body.nome || '').trim(),
    description: String(req.body.descricao || '').trim(),
    icon: String(req.body.icone || 'motor'),
    sort_order: Number(req.body.ordem) || 0,
    active: req.body.ativo === '1' ? 1 : 0,
  };
  if (!v.name) return res.redirect('/admin/linhas');
  if (id) {
    db.prepare('UPDATE product_lines SET name=@name, description=@description, icon=@icon, sort_order=@sort_order, active=@active WHERE id=@id').run({ ...v, id });
    audit(db, req.user.id, 'linha.alterada', 'linha', id, v);
  } else {
    const nid = db.prepare('INSERT INTO product_lines (name, description, icon, sort_order, active) VALUES (@name, @description, @icon, @sort_order, @active)').run(v).lastInsertRowid;
    audit(db, req.user.id, 'linha.criada', 'linha', nid, v);
  }
  res.flash('sucesso', 'Linha salva.');
  res.redirect('/admin/linhas');
});

// ---------------------------------------------------------------- Configurações do site
const SETTING_FIELDS = ['company_name', 'slogan', 'subtitle', 'about_text', 'differentials', 'stats', 'delivery_note', 'whatsapp_number', 'whatsapp_message', 'contact_email', 'contact_phone', 'instagram_url', 'facebook_url', 'cnpj'];

router.get('/configuracoes', (req, res) => {
  res.render('admin/configuracoes', { title: 'Configurações do site', s: getSettings(req.app.locals.db), smtp: smtpConfigured(), error: null });
});

router.post(
  '/configuracoes',
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'imagem_destaque', maxCount: 1 },
  ]),
  checkCsrf,
  (req, res) => {
    const db = req.app.locals.db;
    const before = getSettings(db);
    const changed = {};
    for (const k of SETTING_FIELDS) {
      let val = String(req.body[k] ?? '').trim();
      if (k.endsWith('_url')) val = safeUrl(val);
      if (k === 'company_name' && !val) val = DEFAULT_SETTINGS.company_name;
      if (val !== (before[k] || '')) changed[k] = { de: before[k], para: val };
      setSetting(db, k, val);
    }
    const ancora = req.body.rede_ancora === '1' ? '1' : '0';
    if (ancora !== (before.rede_ancora || '')) changed.rede_ancora = { de: before.rede_ancora, para: ancora };
    setSetting(db, 'rede_ancora', ancora);
    for (const [field, key] of [
      ['logo', 'logo_file_id'],
      ['imagem_destaque', 'hero_file_id'],
    ]) {
      const f = req.files?.[field]?.[0];
      if (f) {
        setSetting(db, key, registerFile(db, f, 'site', null, req.user.id));
        changed[key] = 'nova imagem';
      } else if (req.body[`remover_${field}`] === '1') {
        setSetting(db, key, '');
        changed[key] = 'removida';
      }
    }
    audit(db, req.user.id, 'configuracoes.alteradas', 'configuracoes', null, changed);
    res.flash('sucesso', req.uploadErrors ? `Configurações salvas. ${req.uploadErrors.join(' ')}` : 'Configurações salvas.');
    res.redirect('/admin/configuracoes');
  }
);

// ---------------------------------------------------------------- Histórico de alterações
router.get('/historico', (req, res) => {
  const db = req.app.locals.db;
  const f = {
    usuario: intParam(req.query.usuario) || '',
    tipo: String(req.query.tipo || ''),
    de: parseDateInput(req.query.de) || '',
    ate: parseDateInput(req.query.ate) || '',
    pagina: intParam(req.query.pagina) || 1,
  };
  const where = ['1=1'];
  const p = { limit: 51, offset: (f.pagina - 1) * 50 };
  if (f.usuario) (where.push('l.user_id = @usuario'), (p.usuario = f.usuario));
  if (f.tipo === 'permissoes') where.push("l.action LIKE 'usuario.%'");
  else if (f.tipo === 'conteudo') where.push("(l.action LIKE 'informativo.%' OR l.action LIKE 'album.%' OR l.action LIKE 'evento.%') AND l.action != 'informativo.leitura_confirmada'");
  else if (f.tipo === 'cadastros') where.push("(l.action LIKE 'filial.%' OR l.action LIKE 'setor.%' OR l.action LIKE 'categoria.%' OR l.action LIKE 'linha.%' OR l.action LIKE 'configuracoes.%')");
  else if (f.tipo === 'acessos') where.push("(l.action IN ('login','logout') OR l.action LIKE 'senha.%')");
  if (f.de) (where.push('l.created_at >= @de'), (p.de = localToIso(f.de)));
  if (f.ate) (where.push('l.created_at < @ate'), (p.ate = new Date(new Date(localToIso(f.ate)).getTime() + 86400000).toISOString()));
  const rows = db
    .prepare(
      `SELECT l.*, u.name actor, u.email actor_email FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT @limit OFFSET @offset`
    )
    .all(p);
  const users = db.prepare('SELECT id, name FROM users ORDER BY name').all();
  res.render('admin/historico', { title: 'Histórico de alterações', rows: rows.slice(0, 50), hasMore: rows.length > 50, f, users, ACTION_LABELS });
});

router.get('/emails', (req, res) => {
  const rows = req.app.locals.db.prepare('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 100').all();
  res.render('admin/emails', { title: 'E-mails enviados', rows, smtp: smtpConfigured() });
});

module.exports = router;

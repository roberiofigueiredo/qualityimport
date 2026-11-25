const express = require('express');
const auth = require('../lib/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');
const { audienceSql, liveSql, viewerParams, isVisibleTo } = require('../lib/content');
const { nowIso, todayLocal, localToIso, parseDateInput, MONTHS } = require('../lib/dates');
const { requireLogin, notFound, intParam } = require('./guards');

const router = express.Router();
router.use(requireLogin);

const POST_COLS = `a.*, c.name AS category_name,
  (SELECT confirmed_at FROM post_reads r WHERE r.post_id = a.id AND r.user_id = @uid) AS confirmed_at`;

function visiblePosts(db, user, { q, categoryId, from, to, priority, pendingOnly, excludeIds = [], limit = 20, offset = 0 } = {}) {
  const where = [liveSql(), audienceSql('post')];
  const params = { ...viewerParams(user), uid: user.id, limit, offset };
  if (q) {
    where.push('(a.title LIKE @q OR a.summary LIKE @q OR a.body_html LIKE @q)');
    params.q = `%${q}%`;
  }
  if (categoryId) {
    where.push('a.category_id = @cat');
    params.cat = categoryId;
  }
  if (from) {
    where.push('a.starts_at >= @from');
    params.from = localToIso(from);
  }
  if (to) {
    where.push('a.starts_at < @to');
    params.to = new Date(new Date(localToIso(to)).getTime() + 86400000).toISOString();
  }
  if (priority === true) where.push('a.priority = 1');
  if (priority === false) where.push('a.priority = 0');
  if (pendingOnly) where.push('a.requires_ack = 1 AND NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = a.id AND r.user_id = @uid AND r.confirmed_at IS NOT NULL)');
  if (excludeIds.length) where.push(`a.id NOT IN (${excludeIds.map(Number).join(',')})`);
  const sql = `SELECT ${POST_COLS} FROM posts a LEFT JOIN categories c ON c.id = a.category_id
               WHERE ${where.join(' AND ')} ORDER BY a.priority DESC, a.starts_at DESC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params);
}

function visibleEvents(db, user, { fromDate, toDate, q, limit = 200 } = {}) {
  const where = [liveSql(), audienceSql('event')];
  const params = { ...viewerParams(user), limit };
  if (fromDate) {
    where.push('a.event_date >= @fromDate');
    params.fromDate = fromDate;
  }
  if (toDate) {
    where.push('a.event_date <= @toDate');
    params.toDate = toDate;
  }
  if (q) {
    where.push('(a.title LIKE @q OR a.description LIKE @q OR a.location LIKE @q)');
    params.q = `%${q}%`;
  }
  return db
    .prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM event_changes ch WHERE ch.event_id = a.id) AS change_count
         FROM events a WHERE ${where.join(' AND ')} ORDER BY a.event_date, COALESCE(a.start_time, '00:00') LIMIT @limit`
    )
    .all(params);
}

function visibleAlbums(db, user, { q, from, to, limit = 24 } = {}) {
  const where = [liveSql(), audienceSql('album')];
  const params = { ...viewerParams(user), limit };
  if (q) {
    where.push('(a.title LIKE @q OR a.description LIKE @q)');
    params.q = `%${q}%`;
  }
  if (from) {
    where.push('COALESCE(a.album_date, substr(a.starts_at,1,10)) >= @from');
    params.from = from;
  }
  if (to) {
    where.push('COALESCE(a.album_date, substr(a.starts_at,1,10)) <= @to');
    params.to = to;
  }
  return db
    .prepare(
      `SELECT a.*,
         (SELECT p.file_id FROM photos p WHERE p.id = a.cover_photo_id AND p.album_id = a.id) AS cover_file,
         (SELECT p.file_id FROM photos p WHERE p.album_id = a.id ORDER BY p.position, p.id LIMIT 1) AS first_file,
         (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS photo_count
       FROM albums a WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(a.album_date, '') DESC, a.starts_at DESC LIMIT @limit`
    )
    .all(params);
}

function pendingCount(db, user) {
  return db
    .prepare(
      `SELECT COUNT(*) c FROM posts a WHERE ${liveSql()} AND ${audienceSql('post')} AND a.requires_ack = 1
       AND NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = a.id AND r.user_id = @uid AND r.confirmed_at IS NOT NULL)`
    )
    .get({ ...viewerParams(user), uid: user.id }).c;
}

// contador de pendências disponível no menu de todas as telas da intranet
router.use((req, res, next) => {
  res.locals.pendingCount = pendingCount(req.app.locals.db, req.user);
  next();
});

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const user = req.user;
  const today = todayLocal();
  const priority = visiblePosts(db, user, { priority: true, limit: 5 });
  const pending = visiblePosts(db, user, { pendingOnly: true, limit: 10 });
  const recent = visiblePosts(db, user, { priority: false, limit: 6 });
  const events = visibleEvents(db, user, { fromDate: today, limit: 5 });
  const album = visibleAlbums(db, user, { limit: 1 })[0] || null;
  const albumPhotos = album
    ? db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position, id LIMIT 6').all(album.id)
    : [];
  const changes = db
    .prepare(
      `SELECT ch.*, a.title, a.event_date, a.start_time, a.cancelled FROM event_changes ch JOIN events a ON a.id = ch.event_id
        WHERE ${liveSql()} AND ${audienceSql('event')} AND ch.created_at >= @since AND a.event_date >= @today
        ORDER BY ch.created_at DESC LIMIT 5`
    )
    .all({ ...viewerParams(user), since: new Date(Date.now() - 14 * 86400000).toISOString(), today });
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all();
  res.render('intranet/home', { title: 'Início', priority, pending, recent, events, album, albumPhotos, changes, categories });
});

function searchParams(req) {
  return {
    q: String(req.query.q || '').trim().slice(0, 100),
    categoryId: intParam(req.query.categoria),
    from: parseDateInput(req.query.de),
    to: parseDateInput(req.query.ate),
  };
}

router.get('/informativos', (req, res) => {
  const db = req.app.locals.db;
  const f = searchParams(req);
  const page = intParam(req.query.pagina) || 1;
  const pendingOnly = req.query.pendentes === '1';
  const posts = visiblePosts(db, req.user, { ...f, pendingOnly, limit: 21, offset: (page - 1) * 20 });
  const searching = !!(f.q || f.from || f.to);
  const albums = searching && !f.categoryId && !pendingOnly ? visibleAlbums(db, req.user, { q: f.q, from: f.from, to: f.to, limit: 12 }) : [];
  const events = searching && !f.categoryId && !pendingOnly ? visibleEvents(db, req.user, { q: f.q, fromDate: f.from, toDate: f.to, limit: 12 }) : [];
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all();
  res.render('intranet/informativos', {
    title: pendingOnly ? 'Leituras pendentes' : searching ? 'Resultado da busca' : 'Informativos',
    posts: posts.slice(0, 20),
    hasMore: posts.length > 20,
    page,
    f,
    pendingOnly,
    albums,
    events,
    categories,
  });
});

router.get('/informativos/:id', (req, res) => {
  const db = req.app.locals.db;
  const id = intParam(req.params.id);
  if (!id) return notFound(res);
  if (!isVisibleTo(db, 'post', id, req.user)) {
    // Marketing/TI podem ver qualquer conteúdo pela pré-visualização do painel
    if (can(req.user, 'editorial') && db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return res.redirect(`/painel/informativos/${id}/previa`);
    return notFound(res);
  }
  const post = db
    .prepare('SELECT a.*, c.name AS category_name, u.name AS author_name FROM posts a LEFT JOIN categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ?')
    .get(id);
  db.prepare('INSERT OR IGNORE INTO post_reads (post_id, user_id, first_read_at) VALUES (?, ?, ?)').run(id, req.user.id, nowIso());
  const read = db.prepare('SELECT * FROM post_reads WHERE post_id = ? AND user_id = ?').get(id, req.user.id);
  const attachments = db.prepare("SELECT * FROM files WHERE owner_type = 'post_attachment' AND owner_id = ? ORDER BY created_at").all(id);
  res.render('intranet/informativo', { title: post.title, post, read, attachments, preview: false });
});

router.post('/informativos/:id/confirmar', (req, res) => {
  const db = req.app.locals.db;
  const id = intParam(req.params.id);
  if (!id || !isVisibleTo(db, 'post', id, req.user)) return notFound(res);
  const post = db.prepare('SELECT requires_ack FROM posts WHERE id = ?').get(id);
  if (!post.requires_ack) return res.redirect(`/intranet/informativos/${id}`);
  const now = nowIso();
  db.prepare(
    `INSERT INTO post_reads (post_id, user_id, first_read_at, confirmed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(post_id, user_id) DO UPDATE SET confirmed_at = COALESCE(post_reads.confirmed_at, excluded.confirmed_at)`
  ).run(id, req.user.id, now, now);
  audit(db, req.user.id, 'informativo.leitura_confirmada', 'informativo', id);
  res.flash('sucesso', 'Leitura confirmada. Obrigado!');
  res.redirect(`/intranet/informativos/${id}`);
});

router.get('/galeria', (req, res) => {
  const db = req.app.locals.db;
  const albums = visibleAlbums(db, req.user, { limit: 60 });
  res.render('intranet/galeria', { title: 'Galeria de fotos', albums });
});

router.get('/galeria/:id', (req, res) => {
  const db = req.app.locals.db;
  const id = intParam(req.params.id);
  if (!id) return notFound(res);
  if (!isVisibleTo(db, 'album', id, req.user)) {
    if (can(req.user, 'editorial') && db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id)) return res.redirect(`/painel/galeria/${id}/previa`);
    return notFound(res);
  }
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position, id').all(id);
  res.render('intranet/album', { title: album.title, album, photos, preview: false });
});

function monthBounds(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  const today = todayLocal();
  const y = m ? +m[1] : +today.slice(0, 4);
  const mo = m ? +m[2] : +today.slice(5, 7);
  const first = `${y}-${String(mo).padStart(2, '0')}-01`;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const last = `${y}-${String(mo).padStart(2, '0')}-${String(days).padStart(2, '0')}`;
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const firstWeekday = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  return { y, mo, first, last, days, prev, next, firstWeekday, label: `${MONTHS[mo - 1]} de ${y}` };
}

router.get('/calendario', (req, res) => {
  const db = req.app.locals.db;
  const view = req.query.visao === 'lista' ? 'lista' : 'mes';
  const today = todayLocal();
  let events;
  let month = null;
  if (view === 'mes') {
    month = monthBounds(req.query.mes);
    events = visibleEvents(db, req.user, { fromDate: month.first, toDate: month.last });
  } else {
    events = visibleEvents(db, req.user, { fromDate: req.query.anteriores === '1' ? null : today });
  }
  res.render('intranet/calendario', { title: 'Calendário', view, month, events, today, base: '/intranet/calendario', anteriores: req.query.anteriores === '1' });
});

router.get('/calendario/:id', (req, res) => {
  const db = req.app.locals.db;
  const id = intParam(req.params.id);
  if (!id) return notFound(res);
  if (!isVisibleTo(db, 'event', id, req.user)) {
    if (can(req.user, 'editorial') && db.prepare('SELECT 1 FROM events WHERE id = ?').get(id)) return res.redirect(`/painel/calendario/${id}/editar`);
    return notFound(res);
  }
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  const changes = db.prepare('SELECT * FROM event_changes WHERE event_id = ? ORDER BY created_at DESC').all(id);
  res.render('intranet/evento', { title: event.title, event, changes });
});

router.get('/perfil', (req, res) => {
  const db = req.app.locals.db;
  const info = db
    .prepare('SELECT b.name branch_name, s.name sector_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN sectors s ON s.id = u.sector_id WHERE u.id = ?')
    .get(req.user.id);
  res.render('intranet/perfil', { title: 'Meus dados', info, error: null });
});

router.post('/perfil/senha', (req, res) => {
  const db = req.app.locals.db;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const info = db
    .prepare('SELECT b.name branch_name, s.name sector_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN sectors s ON s.id = u.sector_id WHERE u.id = ?')
    .get(req.user.id);
  const pw = String(req.body.nova || '');
  let error = null;
  if (!auth.verifyPassword(String(req.body.atual || ''), row.password_hash)) error = 'A senha atual está incorreta.';
  else error = auth.passwordProblem(pw) || (pw !== req.body.confirmacao ? 'As senhas não conferem.' : null);
  if (error) return res.status(400).render('intranet/perfil', { title: 'Meus dados', info, error });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.session.sid);
  audit(db, req.user.id, 'senha.definida', 'usuario', req.user.id);
  res.flash('sucesso', 'Senha alterada com sucesso.');
  res.redirect('/intranet/perfil');
});

module.exports = router;
module.exports.monthBounds = monthBounds;

// Painel do Marketing: Informativos, Galeria de fotos e Calendário.
const fs = require('fs');
const express = require('express');
const { audit } = require('../lib/audit');
const { cleanHtml } = require('../lib/html');
const { upload, registerFile } = require('../lib/uploads');
const C = require('../lib/content');
const { nowIso, localToIso, isoToLocalInput, parseDateInput, parseTimeInput, fmtDate, fmtTimeRange, todayLocal } = require('../lib/dates');
const { requireCap, notFound, intParam, checkCsrf } = require('./guards');
const { monthBounds } = require('./intranet');

const router = express.Router();
router.use(requireCap('editorial'));

const KIND = {
  post: { table: 'posts', audit: 'informativo', path: 'informativos', label: 'informativo' },
  album: { table: 'albums', audit: 'album', path: 'galeria', label: 'álbum' },
  event: { table: 'events', audit: 'evento', path: 'calendario', label: 'evento' },
};

function lookups(db) {
  return {
    branches: db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY sort_order, name').all(),
    sectors: db.prepare('SELECT id, name FROM sectors WHERE active = 1 ORDER BY name').all(),
    categories: db.prepare('SELECT id, name FROM categories WHERE active = 1 ORDER BY name').all(),
  };
}

function cleanupUploads(req) {
  const files = Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
  if (req.file) files.push(req.file);
  for (const f of files) fs.unlink(f.path, () => {});
}

/**
 * Regras de publicação compartilhadas.
 * Ações: rascunho | salvar | previsualizar | agendar | publicar
 */
function resolvePublication(existing, body) {
  const now = nowIso();
  const acao = ['rascunho', 'salvar', 'previsualizar', 'agendar', 'publicar'].includes(body.acao) ? body.acao : 'rascunho';
  let starts = body.inicio ? localToIso(body.inicio) : null;
  const ends = body.fim ? localToIso(body.fim) : null;
  if (body.inicio && !starts) return { error: 'Data de início da exibição inválida.' };
  if (body.fim && !ends) return { error: 'Data de fim da exibição inválida.' };
  let status = existing ? existing.status : 'rascunho';
  let publishedAt = existing ? existing.published_at : null;

  if (acao === 'rascunho') status = 'rascunho';
  if (acao === 'agendar') {
    if (!starts || starts <= now) return { error: 'Para agendar, informe a data e o horário de início da exibição (no futuro).' };
    status = 'agendado';
  }
  if (acao === 'publicar') {
    if (!starts || starts > now) starts = now;
    status = 'publicado';
    publishedAt = publishedAt || now;
  }
  if ((acao === 'salvar' || acao === 'previsualizar') && ['publicado', 'agendado'].includes(status) && !starts) {
    starts = existing.starts_at || now;
  }
  if (starts && ends && ends <= starts) return { error: 'O fim da exibição deve ser depois do início.' };
  return { acao, status, starts, ends, publishedAt };
}

function auditPublication(db, user, kind, id, created, pub) {
  const a = KIND[kind].audit;
  audit(db, user.id, `${a}.${created ? 'criado' : 'alterado'}`, a, id);
  if (pub.acao === 'publicar') audit(db, user.id, `${a}.publicado`, a, id);
  if (pub.acao === 'agendar') audit(db, user.id, `${a}.agendado`, a, id, { inicio: pub.starts });
}

function afterSave(res, kind, id, pub) {
  const p = KIND[kind].path;
  const msgs = {
    rascunho: 'Rascunho salvo.',
    salvar: 'Alterações salvas.',
    agendar: 'Conteúdo agendado.',
    publicar: 'Conteúdo publicado.',
  };
  if (pub.acao === 'previsualizar') return res.redirect(`/painel/${p}/${id}/previa`);
  res.flash('sucesso', msgs[pub.acao]);
  res.redirect(`/painel/${p}/${id}/editar`);
}

/** quantos usuários ativos fazem parte do público do conteúdo (para relatórios de leitura) */
function audienceUsersSql(type) {
  return C.audienceSql(type, 'a').replaceAll('@branch', 'u.branch_id').replaceAll('@sector', 'u.sector_id');
}

function listRows(db, kind, { status, q }) {
  const { table } = KIND[kind];
  const where = ['1=1'];
  const params = {};
  if (q) {
    where.push('a.title LIKE @q');
    params.q = `%${q}%`;
  }
  const extra =
    kind === 'post'
      ? `, c.name AS category_name,
         (SELECT COUNT(*) FROM post_reads r WHERE r.post_id = a.id AND r.confirmed_at IS NOT NULL) AS confirmed,
         (SELECT COUNT(*) FROM users u WHERE u.status = 'ativo' AND ${audienceUsersSql('post')}) AS audience_size`
      : kind === 'album'
        ? ', (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS photo_count'
        : '';
  const join = kind === 'post' ? 'LEFT JOIN categories c ON c.id = a.category_id' : '';
  const order = kind === 'event' ? 'a.event_date DESC, a.start_time DESC' : 'a.updated_at DESC';
  let rows = db
    .prepare(`SELECT a.*, u2.name AS updated_by_name ${extra} FROM ${table} a ${join} LEFT JOIN users u2 ON u2.id = COALESCE(a.updated_by, a.created_by) WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all(params);
  const now = nowIso();
  rows = rows.map((r) => ({ ...r, st: C.statusInfo(r, now), audienceText: C.audienceLabel(db, kind, r.id) }));
  if (status) rows = rows.filter((r) => r.st.key === status);
  return rows;
}

// ---------------------------------------------------------------- Início do painel
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const count = (t, extra = '') => db.prepare(`SELECT status, COUNT(*) c FROM ${t} ${extra} GROUP BY status`).all();
  const summarize = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.c]));
  res.render('painel/inicio', {
    title: 'Painel do Marketing',
    stats: { posts: summarize(count('posts')), albums: summarize(count('albums')), events: summarize(count('events')) },
    drafts: db
      .prepare(
        `SELECT 'informativos' p, id, title, updated_at FROM posts WHERE status = 'rascunho'
         UNION ALL SELECT 'galeria', id, title, updated_at FROM albums WHERE status = 'rascunho'
         UNION ALL SELECT 'calendario', id, title, updated_at FROM events WHERE status = 'rascunho'
         ORDER BY updated_at DESC LIMIT 8`
      )
      .all(),
  });
});

// ---------------------------------------------------------------- Informativos
router.get('/informativos', (req, res) => {
  const db = req.app.locals.db;
  const filters = { status: req.query.status || '', q: String(req.query.q || '').trim() };
  res.render('painel/informativos', { title: 'Informativos', rows: listRows(db, 'post', filters), filters });
});

function postForm(db, row) {
  const aud = row && row.id ? C.getAudience(db, 'post', row.id) : { all: true, branchIds: [], sectorIds: [] };
  return {
    id: row?.id || null,
    titulo: row?.title || '',
    resumo: row?.summary || '',
    corpo: row?.body_html || '',
    categoria: row?.category_id || '',
    destaque: !!row?.priority,
    confirmacao: !!row?.requires_ack,
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: isoToLocalInput(row?.starts_at),
    fim: isoToLocalInput(row?.ends_at),
    status: row?.status || 'rascunho',
    cover_file_id: row?.cover_file_id || null,
  };
}

function renderPostForm(req, res, { row, form, error, status = 200 }) {
  const db = req.app.locals.db;
  const attachments = row ? db.prepare("SELECT * FROM files WHERE owner_type = 'post_attachment' AND owner_id = ? ORDER BY created_at").all(row.id) : [];
  res.status(status).render('painel/informativo-form', {
    title: row ? 'Editar informativo' : 'Novo informativo',
    row,
    form: form || postForm(db, row),
    st: row ? C.statusInfo(row) : null,
    attachments,
    error,
    ...lookups(db),
  });
}

router.get('/informativos/novo', (req, res) => renderPostForm(req, res, { row: null }));

router.get('/informativos/:id/editar', (req, res) => {
  const row = req.app.locals.db.prepare('SELECT * FROM posts WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  renderPostForm(req, res, { row });
});

const postUpload = upload.fields([
  { name: 'capa', maxCount: 1 },
  { name: 'anexos', maxCount: 10 },
]);

function savePost(req, res) {
  const db = req.app.locals.db;
  const id = req.params.id ? intParam(req.params.id) : null;
  const existing = id ? db.prepare('SELECT * FROM posts WHERE id = ?').get(id) : null;
  if (id && !existing) {
    cleanupUploads(req);
    return notFound(res);
  }
  const b = req.body;
  const aud = C.audienceFromBody(b);
  const form = {
    ...postForm(db, existing),
    titulo: String(b.titulo || '').trim(),
    resumo: String(b.resumo || '').trim(),
    corpo: cleanHtml(b.corpo),
    categoria: intParam(b.categoria) || '',
    destaque: b.destaque === '1',
    confirmacao: b.confirmacao === '1',
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: b.inicio || '',
    fim: b.fim || '',
  };
  let error = null;
  if (!form.titulo) error = 'Informe o título.';
  else if (!aud.all && !aud.branchIds.length && !aud.sectorIds.length) error = 'Selecione ao menos uma filial ou um setor para o público-alvo.';
  else if (req.uploadErrors) error = req.uploadErrors.join(' ');
  const pub = error ? null : resolvePublication(existing, b);
  if (pub && pub.error) error = pub.error;
  if (error) {
    cleanupUploads(req);
    return renderPostForm(req, res, { row: existing, form, error, status: 400 });
  }

  const now = nowIso();
  const savedId = db.transaction(() => {
    const vals = {
      title: form.titulo,
      summary: form.resumo,
      body_html: form.corpo,
      category_id: form.categoria || null,
      priority: form.destaque ? 1 : 0,
      requires_ack: form.confirmacao ? 1 : 0,
      status: pub.status,
      starts_at: pub.starts,
      ends_at: pub.ends,
      published_at: pub.publishedAt,
      uid: req.user.id,
      now,
    };
    let pid = id;
    if (existing) {
      db.prepare(
        `UPDATE posts SET title=@title, summary=@summary, body_html=@body_html, category_id=@category_id, priority=@priority,
           requires_ack=@requires_ack, status=@status, starts_at=@starts_at, ends_at=@ends_at, published_at=@published_at,
           updated_by=@uid, updated_at=@now WHERE id=@id`
      ).run({ ...vals, id });
    } else {
      pid = db
        .prepare(
          `INSERT INTO posts (title, summary, body_html, category_id, priority, requires_ack, status, starts_at, ends_at, published_at,
             created_by, updated_by, created_at, updated_at)
           VALUES (@title, @summary, @body_html, @category_id, @priority, @requires_ack, @status, @starts_at, @ends_at, @published_at,
             @uid, @uid, @now, @now)`
        )
        .run(vals).lastInsertRowid;
    }
    C.saveAudience(db, 'post', pid, aud);
    const capa = req.files?.capa?.[0];
    if (capa) {
      const fid = registerFile(db, capa, 'post_cover', pid, req.user.id);
      db.prepare('UPDATE posts SET cover_file_id = ? WHERE id = ?').run(fid, pid);
    } else if (b.remover_capa === '1') {
      db.prepare('UPDATE posts SET cover_file_id = NULL WHERE id = ?').run(pid);
    }
    for (const f of req.files?.anexos || []) registerFile(db, f, 'post_attachment', pid, req.user.id);
    for (const fid of [].concat(b.remover_anexo || [])) {
      db.prepare("UPDATE files SET owner_type = 'removido' WHERE id = ? AND owner_type = 'post_attachment' AND owner_id = ?").run(String(fid), pid);
    }
    return Number(pid);
  })();
  auditPublication(db, req.user, 'post', savedId, !existing, pub);
  afterSave(res, 'post', savedId, pub);
}

router.post('/informativos', postUpload, checkCsrf, savePost);
router.post('/informativos/:id', postUpload, checkCsrf, savePost);

router.get('/informativos/:id/previa', (req, res) => {
  const db = req.app.locals.db;
  const post = db
    .prepare('SELECT a.*, c.name AS category_name, u.name AS author_name FROM posts a LEFT JOIN categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ?')
    .get(intParam(req.params.id));
  if (!post) return notFound(res);
  const attachments = db.prepare("SELECT * FROM files WHERE owner_type = 'post_attachment' AND owner_id = ? ORDER BY created_at").all(post.id);
  res.render('intranet/informativo', {
    title: `Pré-visualização: ${post.title}`,
    post,
    read: null,
    attachments,
    preview: { st: C.statusInfo(post), audience: C.audienceLabel(db, 'post', post.id), edit: `/painel/informativos/${post.id}/editar` },
  });
});

router.get('/informativos/:id/leituras', (req, res) => {
  const db = req.app.locals.db;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(intParam(req.params.id));
  if (!post) return notFound(res);
  const readers = db
    .prepare(
      `SELECT u.name, u.email, b.name branch_name, s.name sector_name, r.first_read_at, r.confirmed_at
         FROM users u JOIN posts a ON a.id = @id
         LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN sectors s ON s.id = u.sector_id
         LEFT JOIN post_reads r ON r.post_id = a.id AND r.user_id = u.id
        WHERE u.status = 'ativo' AND ${audienceUsersSql('post')}
        ORDER BY r.confirmed_at IS NULL DESC, u.name`
    )
    .all({ id: post.id });
  res.render('painel/leituras', { title: 'Confirmações de leitura', post, readers, audience: C.audienceLabel(db, 'post', post.id) });
});

// ---------------------------------------------------------------- Retirar de circulação (com confirmação)
for (const kind of ['post', 'album', 'event']) {
  const k = KIND[kind];
  router.get(`/${k.path}/:id/arquivar`, (req, res) => {
    const row = req.app.locals.db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(intParam(req.params.id));
    if (!row) return notFound(res);
    res.render('painel/confirmar', {
      title: 'Retirar de circulação',
      heading: `Retirar “${row.title}” de circulação?`,
      message: `O ${k.label} deixará de aparecer para os colaboradores imediatamente. Ele continuará salvo no painel com o status “Arquivado” e poderá ser publicado novamente depois.`,
      action: `/painel/${k.path}/${row.id}/arquivar`,
      confirmLabel: 'Sim, retirar de circulação',
      back: `/painel/${k.path}/${row.id}/editar`,
      extraField: null,
    });
  });
  router.post(`/${k.path}/:id/arquivar`, (req, res) => {
    const db = req.app.locals.db;
    const row = db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(intParam(req.params.id));
    if (!row) return notFound(res);
    if (req.body.confirmar !== 'sim') return res.redirect(`/painel/${k.path}/${row.id}/arquivar`);
    db.prepare(`UPDATE ${k.table} SET status = 'arquivado', updated_by = ?, updated_at = ? WHERE id = ?`).run(req.user.id, nowIso(), row.id);
    audit(db, req.user.id, `${k.audit}.arquivado`, k.audit, row.id);
    res.flash('sucesso', 'Conteúdo retirado de circulação.');
    res.redirect(`/painel/${k.path}`);
  });
}

// ---------------------------------------------------------------- Galeria de fotos
router.get('/galeria', (req, res) => {
  const db = req.app.locals.db;
  const filters = { status: req.query.status || '', q: String(req.query.q || '').trim() };
  res.render('painel/galeria', { title: 'Galeria de fotos', rows: listRows(db, 'album', filters), filters });
});

function albumForm(db, row) {
  const aud = row && row.id ? C.getAudience(db, 'album', row.id) : { all: true, branchIds: [], sectorIds: [] };
  return {
    titulo: row?.title || '',
    descricao: row?.description || '',
    data: row?.album_date || todayLocal(),
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: isoToLocalInput(row?.starts_at),
    fim: isoToLocalInput(row?.ends_at),
    status: row?.status || 'rascunho',
  };
}

function renderAlbumForm(req, res, { row, form, error, status = 200 }) {
  const db = req.app.locals.db;
  const photos = row ? db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position, id').all(row.id) : [];
  res.status(status).render('painel/album-form', {
    title: row ? 'Editar álbum' : 'Novo álbum',
    row,
    form: form || albumForm(db, row),
    st: row ? C.statusInfo(row) : null,
    photos,
    error,
    ...lookups(db),
  });
}

router.get('/galeria/novo', (req, res) => renderAlbumForm(req, res, { row: null }));
router.get('/galeria/:id/editar', (req, res) => {
  const row = req.app.locals.db.prepare('SELECT * FROM albums WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  renderAlbumForm(req, res, { row });
});

function addPhotos(db, albumId, files, userId) {
  let pos = db.prepare('SELECT COALESCE(MAX(position), 0) m FROM photos WHERE album_id = ?').get(albumId).m;
  const ins = db.prepare('INSERT INTO photos (album_id, file_id, caption, position, created_at) VALUES (?, ?, ?, ?, ?)');
  const ids = [];
  for (const f of files) {
    const fid = registerFile(db, f, 'photo', albumId, userId);
    ids.push(ins.run(albumId, fid, '', ++pos, nowIso()).lastInsertRowid);
  }
  const album = db.prepare('SELECT cover_photo_id FROM albums WHERE id = ?').get(albumId);
  if (!album.cover_photo_id && ids.length) db.prepare('UPDATE albums SET cover_photo_id = ? WHERE id = ?').run(ids[0], albumId);
  return ids.length;
}

function saveAlbum(req, res) {
  const db = req.app.locals.db;
  const id = req.params.id ? intParam(req.params.id) : null;
  const existing = id ? db.prepare('SELECT * FROM albums WHERE id = ?').get(id) : null;
  if (id && !existing) {
    cleanupUploads(req);
    return notFound(res);
  }
  const b = req.body;
  const aud = C.audienceFromBody(b);
  const form = {
    ...albumForm(db, existing),
    titulo: String(b.titulo || '').trim(),
    descricao: String(b.descricao || '').trim(),
    data: b.data || '',
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: b.inicio || '',
    fim: b.fim || '',
  };
  let error = null;
  const albumDate = parseDateInput(b.data);
  if (!form.titulo) error = 'Informe o título do álbum.';
  else if (!albumDate) error = 'Informe a data do álbum.';
  else if (!aud.all && !aud.branchIds.length && !aud.sectorIds.length) error = 'Selecione ao menos uma filial ou um setor para o público-alvo.';
  else if (req.uploadErrors) error = req.uploadErrors.join(' ');
  const pub = error ? null : resolvePublication(existing, b);
  if (pub && pub.error) error = pub.error;
  const hasPhotos = (req.files || []).length > 0 || (existing && db.prepare('SELECT 1 FROM photos WHERE album_id = ?').get(existing.id));
  if (!error && ['agendar', 'publicar'].includes(pub.acao) && !hasPhotos) error = 'Adicione ao menos uma foto antes de publicar ou agendar o álbum.';
  if (error) {
    cleanupUploads(req);
    return renderAlbumForm(req, res, { row: existing, form, error, status: 400 });
  }
  const now = nowIso();
  const savedId = db.transaction(() => {
    const vals = {
      title: form.titulo,
      description: form.descricao,
      album_date: albumDate,
      status: pub.status,
      starts_at: pub.starts,
      ends_at: pub.ends,
      published_at: pub.publishedAt,
      uid: req.user.id,
      now,
    };
    let aid = id;
    if (existing) {
      db.prepare(
        `UPDATE albums SET title=@title, description=@description, album_date=@album_date, status=@status, starts_at=@starts_at,
          ends_at=@ends_at, published_at=@published_at, updated_by=@uid, updated_at=@now WHERE id=@id`
      ).run({ ...vals, id });
    } else {
      aid = db
        .prepare(
          `INSERT INTO albums (title, description, album_date, status, starts_at, ends_at, published_at, created_by, updated_by, created_at, updated_at)
           VALUES (@title, @description, @album_date, @status, @starts_at, @ends_at, @published_at, @uid, @uid, @now, @now)`
        )
        .run(vals).lastInsertRowid;
    }
    C.saveAudience(db, 'album', aid, aud);
    const n = addPhotos(db, aid, req.files || [], req.user.id);
    if (n) audit(db, req.user.id, 'album.fotos_adicionadas', 'album', aid, { quantidade: n });
    return Number(aid);
  })();
  auditPublication(db, req.user, 'album', savedId, !existing, pub);
  afterSave(res, 'album', savedId, pub);
}

const photosUpload = upload.array('fotos', 50);
router.post('/galeria', photosUpload, checkCsrf, saveAlbum);
router.post('/galeria/:id', photosUpload, checkCsrf, saveAlbum);

// envio de várias fotos de uma vez para um álbum existente
router.post('/galeria/:id/fotos', photosUpload, checkCsrf, (req, res) => {
  const db = req.app.locals.db;
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(intParam(req.params.id));
  if (!album) {
    cleanupUploads(req);
    return notFound(res);
  }
  const n = db.transaction(() => addPhotos(db, album.id, req.files || [], req.user.id))();
  db.prepare('UPDATE albums SET updated_by = ?, updated_at = ? WHERE id = ?').run(req.user.id, nowIso(), album.id);
  if (n) audit(db, req.user.id, 'album.fotos_adicionadas', 'album', album.id, { quantidade: n });
  const errs = req.uploadErrors ? ` ${req.uploadErrors.join(' ')}` : '';
  res.flash(n ? 'sucesso' : 'erro', n ? `${n} foto(s) adicionada(s).${errs}` : `Nenhuma foto foi enviada.${errs}`);
  res.redirect(`/painel/galeria/${album.id}/editar#fotos`);
});

// legendas, capa, ordem e remoção
router.post('/galeria/:id/fotos/organizar', (req, res) => {
  const db = req.app.locals.db;
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(intParam(req.params.id));
  if (!album) return notFound(res);
  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position, id').all(album.id);
  const remove = new Set([].concat(req.body.remover || []).map(Number));
  db.transaction(() => {
    const upd = db.prepare('UPDATE photos SET caption = ?, position = ? WHERE id = ? AND album_id = ?');
    for (const p of photos) {
      if (remove.has(p.id)) {
        db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
        db.prepare("UPDATE files SET owner_type = 'removido' WHERE id = ?").run(p.file_id);
        audit(db, req.user.id, 'album.foto_removida', 'album', album.id, { foto: p.id });
        continue;
      }
      const caption = String(req.body[`legenda_${p.id}`] ?? p.caption ?? '').trim().slice(0, 300);
      const pos = Number(req.body[`ordem_${p.id}`]);
      upd.run(caption, Number.isFinite(pos) ? pos : p.position, p.id, album.id);
    }
    // normaliza a ordem 1..n
    const ordered = db.prepare('SELECT id FROM photos WHERE album_id = ? ORDER BY position, id').all(album.id);
    ordered.forEach((p, i) => db.prepare('UPDATE photos SET position = ? WHERE id = ?').run(i + 1, p.id));
    let cover = intParam(req.body.capa);
    if (!cover || remove.has(cover) || !ordered.some((p) => p.id === cover)) cover = ordered.some((p) => p.id === album.cover_photo_id) ? album.cover_photo_id : ordered[0]?.id || null;
    db.prepare('UPDATE albums SET cover_photo_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(cover, req.user.id, nowIso(), album.id);
  })();
  audit(db, req.user.id, 'album.alterado', 'album', album.id, { fotos: 'organizadas' });
  res.flash('sucesso', 'Fotos atualizadas.');
  res.redirect(`/painel/galeria/${album.id}/editar#fotos`);
});

router.post('/galeria/:id/fotos/:pid/mover', (req, res) => {
  const db = req.app.locals.db;
  const albumId = intParam(req.params.id);
  const photos = db.prepare('SELECT id FROM photos WHERE album_id = ? ORDER BY position, id').all(albumId);
  const i = photos.findIndex((p) => p.id === intParam(req.params.pid));
  if (i < 0) return notFound(res);
  const j = req.body.direcao === 'subir' ? i - 1 : i + 1;
  if (j >= 0 && j < photos.length) [photos[i], photos[j]] = [photos[j], photos[i]];
  db.transaction(() => photos.forEach((p, k) => db.prepare('UPDATE photos SET position = ? WHERE id = ?').run(k + 1, p.id)))();
  res.redirect(`/painel/galeria/${albumId}/editar#foto-${req.params.pid}`);
});

router.get('/galeria/:id/previa', (req, res) => {
  const db = req.app.locals.db;
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(intParam(req.params.id));
  if (!album) return notFound(res);
  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position, id').all(album.id);
  res.render('intranet/album', {
    title: `Pré-visualização: ${album.title}`,
    album,
    photos,
    preview: { st: C.statusInfo(album), audience: C.audienceLabel(db, 'album', album.id), edit: `/painel/galeria/${album.id}/editar` },
  });
});

// ---------------------------------------------------------------- Calendário
router.get('/calendario', (req, res) => {
  const db = req.app.locals.db;
  const view = req.query.visao === 'mes' ? 'mes' : 'lista';
  const filters = { status: req.query.status || '', q: String(req.query.q || '').trim() };
  let rows = listRows(db, 'event', filters);
  let month = null;
  if (view === 'mes') {
    month = monthBounds(req.query.mes);
    rows = rows.filter((r) => r.event_date >= month.first && r.event_date <= month.last);
  }
  res.render('painel/calendario', { title: 'Calendário', rows, filters, view, month, today: todayLocal() });
});

function eventForm(db, row) {
  const aud = row && row.id ? C.getAudience(db, 'event', row.id) : { all: true, branchIds: [], sectorIds: [] };
  return {
    titulo: row?.title || '',
    descricao: row?.description || '',
    data: row?.event_date || '',
    hora_inicio: row?.start_time || '',
    hora_fim: row?.end_time || '',
    local: row?.location || '',
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: isoToLocalInput(row?.starts_at),
    fim: isoToLocalInput(row?.ends_at),
    status: row?.status || 'rascunho',
  };
}

function renderEventForm(req, res, { row, form, error, status = 200 }) {
  const db = req.app.locals.db;
  const changes = row ? db.prepare('SELECT ch.*, u.name user_name FROM event_changes ch LEFT JOIN users u ON u.id = ch.changed_by WHERE event_id = ? ORDER BY created_at DESC').all(row.id) : [];
  res.status(status).render('painel/evento-form', {
    title: row ? 'Editar evento' : 'Novo evento',
    row,
    form: form || eventForm(db, row),
    st: row ? C.statusInfo(row) : null,
    changes,
    error,
    ...lookups(db),
  });
}

router.get('/calendario/novo', (req, res) => renderEventForm(req, res, { row: null }));
router.get('/calendario/:id/editar', (req, res) => {
  const row = req.app.locals.db.prepare('SELECT * FROM events WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  renderEventForm(req, res, { row });
});

function describeEventChanges(before, after) {
  const out = [];
  if (before.event_date !== after.event_date) out.push(`Data alterada de ${fmtDate(before.event_date)} para ${fmtDate(after.event_date)}`);
  if (before.start_time !== after.start_time || before.end_time !== after.end_time) {
    out.push(`Horário alterado de ${fmtTimeRange(before.start_time, before.end_time)} para ${fmtTimeRange(after.start_time, after.end_time)}`);
  }
  if ((before.location || '') !== (after.location || '')) out.push(`Local alterado de “${before.location || 'não informado'}” para “${after.location || 'não informado'}”`);
  return out;
}

router.post('/calendario', saveEvent);
router.post('/calendario/:id', saveEvent);
function saveEvent(req, res) {
  const db = req.app.locals.db;
  const id = req.params.id ? intParam(req.params.id) : null;
  const existing = id ? db.prepare('SELECT * FROM events WHERE id = ?').get(id) : null;
  if (id && !existing) return notFound(res);
  const b = req.body;
  const aud = C.audienceFromBody(b);
  const form = {
    ...eventForm(db, existing),
    titulo: String(b.titulo || '').trim(),
    descricao: String(b.descricao || '').trim(),
    data: b.data || '',
    hora_inicio: b.hora_inicio || '',
    hora_fim: b.hora_fim || '',
    local: String(b.local || '').trim(),
    publico: aud.all ? 'todos' : 'selecionado',
    filiais: aud.branchIds,
    setores: aud.sectorIds,
    inicio: b.inicio || '',
    fim: b.fim || '',
  };
  const date = parseDateInput(b.data);
  const t1 = b.hora_inicio ? parseTimeInput(b.hora_inicio) : null;
  const t2 = b.hora_fim ? parseTimeInput(b.hora_fim) : null;
  let error = null;
  if (!form.titulo) error = 'Informe o título do evento.';
  else if (!date) error = 'Informe uma data válida para o evento.';
  else if ((b.hora_inicio && !t1) || (b.hora_fim && !t2)) error = 'Horário inválido. Use o formato 24 horas, por exemplo 14:30.';
  else if (t2 && !t1) error = 'Informe o horário de início.';
  else if (t1 && t2 && t2 <= t1) error = 'O horário de término deve ser depois do início.';
  else if (!aud.all && !aud.branchIds.length && !aud.sectorIds.length) error = 'Selecione ao menos uma filial ou um setor para o público-alvo.';
  const pub = error ? null : resolvePublication(existing, b);
  if (pub && pub.error) error = pub.error;
  if (error) return renderEventForm(req, res, { row: existing, form, error, status: 400 });

  const now = nowIso();
  const after = { event_date: date, start_time: t1, end_time: t2, location: form.local || null };
  const wasLive = existing && ['publicado', 'agendado'].includes(existing.status) && existing.starts_at && existing.starts_at <= now;
  const changes = wasLive ? describeEventChanges(existing, after) : [];
  const savedId = db.transaction(() => {
    const vals = {
      title: form.titulo,
      description: form.descricao,
      ...after,
      status: pub.status,
      starts_at: pub.starts,
      ends_at: pub.ends,
      published_at: pub.publishedAt,
      uid: req.user.id,
      now,
    };
    let eid = id;
    if (existing) {
      db.prepare(
        `UPDATE events SET title=@title, description=@description, event_date=@event_date, start_time=@start_time, end_time=@end_time,
           location=@location, status=@status, starts_at=@starts_at, ends_at=@ends_at, published_at=@published_at, updated_by=@uid, updated_at=@now
         WHERE id=@id`
      ).run({ ...vals, id });
    } else {
      eid = db
        .prepare(
          `INSERT INTO events (title, description, event_date, start_time, end_time, location, status, starts_at, ends_at, published_at,
             created_by, updated_by, created_at, updated_at)
           VALUES (@title, @description, @event_date, @start_time, @end_time, @location, @status, @starts_at, @ends_at, @published_at,
             @uid, @uid, @now, @now)`
        )
        .run(vals).lastInsertRowid;
    }
    C.saveAudience(db, 'event', eid, aud);
    for (const text of changes) {
      db.prepare('INSERT INTO event_changes (event_id, description, changed_by, created_at) VALUES (?, ?, ?, ?)').run(eid, text, req.user.id, now);
    }
    return Number(eid);
  })();
  auditPublication(db, req.user, 'event', savedId, !existing, pub);
  if (changes.length) audit(db, req.user.id, 'evento.alterado', 'evento', savedId, { mudancas: changes });
  afterSave(res, 'event', savedId, pub);
}

router.get('/calendario/:id/previa', (req, res) => {
  const db = req.app.locals.db;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(intParam(req.params.id));
  if (!event) return notFound(res);
  const changes = db.prepare('SELECT * FROM event_changes WHERE event_id = ? ORDER BY created_at DESC').all(event.id);
  res.render('intranet/evento', {
    title: `Pré-visualização: ${event.title}`,
    event,
    changes,
    preview: { st: C.statusInfo(event), audience: C.audienceLabel(db, 'event', event.id), edit: `/painel/calendario/${event.id}/editar` },
  });
});

router.get('/calendario/:id/cancelar', (req, res) => {
  const row = req.app.locals.db.prepare('SELECT * FROM events WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  res.render('painel/confirmar', {
    title: 'Cancelar evento',
    heading: `Cancelar o evento “${row.title}”?`,
    message: 'O evento continuará visível na agenda dos colaboradores, marcado como CANCELADO, para que todos fiquem sabendo da mudança.',
    action: `/painel/calendario/${row.id}/cancelar`,
    confirmLabel: 'Sim, cancelar evento',
    back: `/painel/calendario/${row.id}/editar`,
    extraField: { name: 'motivo', label: 'Motivo do cancelamento (opcional)' },
  });
});

router.post('/calendario/:id/cancelar', (req, res) => {
  const db = req.app.locals.db;
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  if (req.body.confirmar !== 'sim') return res.redirect(`/painel/calendario/${row.id}/cancelar`);
  const reason = String(req.body.motivo || '').trim().slice(0, 300);
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE events SET cancelled = 1, cancel_reason = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(reason || null, req.user.id, now, row.id);
    db.prepare('INSERT INTO event_changes (event_id, description, changed_by, created_at) VALUES (?, ?, ?, ?)').run(
      row.id,
      `Evento cancelado${reason ? `: ${reason}` : ''}`,
      req.user.id,
      now
    );
  })();
  audit(db, req.user.id, 'evento.cancelado', 'evento', row.id, reason ? { motivo: reason } : null);
  res.flash('sucesso', 'Evento cancelado. Os colaboradores verão o aviso na agenda.');
  res.redirect(`/painel/calendario/${row.id}/editar`);
});

router.post('/calendario/:id/reativar', (req, res) => {
  const db = req.app.locals.db;
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(intParam(req.params.id));
  if (!row) return notFound(res);
  const now = nowIso();
  db.prepare('UPDATE events SET cancelled = 0, cancel_reason = NULL, updated_by = ?, updated_at = ? WHERE id = ?').run(req.user.id, now, row.id);
  db.prepare('INSERT INTO event_changes (event_id, description, changed_by, created_at) VALUES (?, ?, ?, ?)').run(row.id, 'Evento confirmado novamente (cancelamento desfeito)', req.user.id, now);
  audit(db, req.user.id, 'evento.alterado', 'evento', row.id, { cancelamento: 'desfeito' });
  res.flash('sucesso', 'Cancelamento desfeito.');
  res.redirect(`/painel/calendario/${row.id}/editar`);
});

module.exports = router;
module.exports.resolvePublication = resolvePublication;

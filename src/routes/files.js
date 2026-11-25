const fs = require('fs');
const express = require('express');
const { can } = require('../lib/permissions');
const { isVisibleTo } = require('../lib/content');
const { filePath } = require('../lib/uploads');
const { notFound } = require('./guards');

const router = express.Router();

/**
 * Todos os arquivos enviados passam por aqui. A permissão é conferida no servidor:
 * - 'site' (logomarca, imagem do site público): acesso livre;
 * - capa/anexo de informativo e fotos de álbum: somente para o público do conteúdo
 *   (ou Marketing/TI, que administram o conteúdo);
 * - qualquer outro caso: somente Marketing/TI.
 */
router.get('/arquivos/:id', (req, res) => {
  const db = req.app.locals.db;
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.id));
  if (!file) return notFound(res);

  let allowed = false;
  if (file.owner_type === 'site') allowed = true;
  else if (!req.user) return res.redirect(`/entrar?volta=${encodeURIComponent(req.originalUrl)}`);
  else if (can(req.user, 'editorial')) allowed = true;
  else if (file.owner_type === 'post_cover' || file.owner_type === 'post_attachment') allowed = isVisibleTo(db, 'post', file.owner_id, req.user);
  else if (file.owner_type === 'photo') {
    const photo = db.prepare('SELECT album_id FROM photos WHERE file_id = ?').get(file.id);
    allowed = !!photo && isVisibleTo(db, 'album', photo.album_id, req.user);
  }
  if (!allowed) return notFound(res);

  const p = filePath(file);
  if (!fs.existsSync(p)) return notFound(res);
  const inline = file.mime.startsWith('image/') || file.mime === 'application/pdf';
  res.set({
    'Content-Type': file.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    'Cache-Control': file.owner_type === 'site' ? 'public, max-age=3600' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(p).pipe(res);
});

module.exports = router;

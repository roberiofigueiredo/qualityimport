// Regras de público-alvo, status de publicação e visibilidade de conteúdo.
const { nowIso } = require('./dates');

const TABLES = { post: 'posts', album: 'albums', event: 'events' };

/**
 * Fragmento SQL: o conteúdo (alias `a`) é destinado ao usuário?
 * Regra: audience_all = 1, OU (filial do usuário entre as filiais selecionadas, se houver)
 * E (setor do usuário entre os setores selecionados, se houver).
 * Parâmetros nomeados: @branch, @sector.
 */
function audienceSql(type, a = 'a') {
  const t = `'${type}'`;
  return `(${a}.audience_all = 1 OR (
      (EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.branch_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.sector_id IS NOT NULL))
      AND (NOT EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.branch_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.branch_id = @branch))
      AND (NOT EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.sector_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM audiences x WHERE x.content_type = ${t} AND x.content_id = ${a}.id AND x.sector_id = @sector))
    ))`;
}

/** Fragmento SQL: o conteúdo está em circulação agora? Parâmetro @now. */
function liveSql(a = 'a') {
  return `(${a}.status IN ('publicado','agendado') AND ${a}.starts_at IS NOT NULL AND ${a}.starts_at <= @now
           AND (${a}.ends_at IS NULL OR ${a}.ends_at > @now))`;
}

function viewerParams(user) {
  return { branch: user.branch_id ?? -1, sector: user.sector_id ?? -1, now: nowIso() };
}

/** O conteúdo `type`/`id` está publicado e destinado a este usuário? (checagem no servidor) */
function isVisibleTo(db, type, id, user) {
  const row = db
    .prepare(`SELECT 1 FROM ${TABLES[type]} a WHERE a.id = @id AND ${liveSql()} AND ${audienceSql(type)}`)
    .get({ id, ...viewerParams(user) });
  return !!row;
}

function getAudience(db, type, id) {
  const row = db.prepare(`SELECT audience_all FROM ${TABLES[type]} WHERE id = ?`).get(id);
  const rows = db.prepare('SELECT branch_id, sector_id FROM audiences WHERE content_type = ? AND content_id = ?').all(type, id);
  return {
    all: !row || row.audience_all === 1,
    branchIds: rows.filter((r) => r.branch_id).map((r) => r.branch_id),
    sectorIds: rows.filter((r) => r.sector_id).map((r) => r.sector_id),
  };
}

function toIdList(v) {
  if (v == null || v === '') return [];
  return [].concat(v).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** Lê o público-alvo enviado pelo formulário. */
function audienceFromBody(body) {
  const all = body.publico !== 'selecionado';
  return { all, branchIds: all ? [] : toIdList(body.filiais), sectorIds: all ? [] : toIdList(body.setores) };
}

function saveAudience(db, type, id, aud) {
  db.prepare(`UPDATE ${TABLES[type]} SET audience_all = ? WHERE id = ?`).run(aud.all ? 1 : 0, id);
  db.prepare('DELETE FROM audiences WHERE content_type = ? AND content_id = ?').run(type, id);
  const ins = db.prepare('INSERT INTO audiences (content_type, content_id, branch_id, sector_id) VALUES (?, ?, ?, ?)');
  for (const b of aud.branchIds) ins.run(type, id, b, null);
  for (const s of aud.sectorIds) ins.run(type, id, null, s);
}

/** Texto legível do público-alvo, ex.: "Filial Centro · Setor Vendas" */
function audienceLabel(db, type, id) {
  const aud = getAudience(db, type, id);
  if (aud.all) return 'Toda a empresa';
  const parts = [];
  if (aud.branchIds.length) {
    const names = db.prepare(`SELECT name FROM branches WHERE id IN (${aud.branchIds.map(() => '?').join(',')}) ORDER BY name`).all(...aud.branchIds);
    parts.push((names.length > 1 ? 'Filiais: ' : 'Filial: ') + names.map((n) => n.name).join(', '));
  }
  if (aud.sectorIds.length) {
    const names = db.prepare(`SELECT name FROM sectors WHERE id IN (${aud.sectorIds.map(() => '?').join(',')}) ORDER BY name`).all(...aud.sectorIds);
    parts.push((names.length > 1 ? 'Setores: ' : 'Setor: ') + names.map((n) => n.name).join(', '));
  }
  return parts.join(' · ') || 'Nenhum público selecionado';
}

/** Status exibido no painel. */
function statusInfo(row, now = nowIso()) {
  if (row.status === 'rascunho') return { key: 'rascunho', label: 'Rascunho' };
  if (row.status === 'arquivado') return { key: 'arquivado', label: 'Arquivado' };
  if (row.cancelled) return { key: 'cancelado', label: 'Cancelado' };
  if (row.starts_at && row.starts_at > now) return { key: 'agendado', label: 'Agendado' };
  if (row.ends_at && row.ends_at <= now) return { key: 'encerrado', label: 'Exibição encerrada' };
  return { key: 'publicado', label: 'Publicado' };
}

module.exports = {
  TABLES,
  audienceSql,
  liveSql,
  viewerParams,
  isVisibleTo,
  getAudience,
  audienceFromBody,
  saveAudience,
  audienceLabel,
  statusInfo,
  toIdList,
};

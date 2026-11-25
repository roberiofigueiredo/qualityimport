// Datas no padrão brasileiro (DD/MM/AAAA, 24 horas), fuso America/Sao_Paulo.
const TZ = process.env.TZ_APP || 'America/Sao_Paulo';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function nowIso() {
  return new Date().toISOString();
}

function partsInTz(date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return p;
}

/** 'AAAA-MM-DD' de hoje no fuso local */
function todayLocal(date = new Date()) {
  const p = partsInTz(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:MM' agora no fuso local */
function nowTimeLocal(date = new Date()) {
  const p = partsInTz(date);
  return `${p.hour}:${p.minute}`;
}

/** Converte 'AAAA-MM-DDTHH:MM' (horário local) em ISO UTC. */
function localToIso(local) {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(local).trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // descobre o deslocamento do fuso naquele instante
  const p = partsInTz(new Date(asUtc));
  const tzAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offset = tzAsUtc - asUtc;
  return new Date(asUtc - offset).toISOString();
}

/** ISO UTC -> 'AAAA-MM-DDTHH:MM' local (para <input type="datetime-local">) */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const p = partsInTz(new Date(iso));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Aceita ISO completo ou 'AAAA-MM-DD' e devolve 'DD/MM/AAAA' */
function fmtDate(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  const p = partsInTz(new Date(v));
  return `${p.day}/${p.month}/${p.year}`;
}

/** ISO -> 'DD/MM/AAAA HH:MM' */
function fmtDateTime(v) {
  if (!v) return '';
  const p = partsInTz(new Date(v));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** 'AAAA-MM-DD' -> 'segunda-feira, 01/12/2026' */
function fmtLongDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${fmtDate(ymd)}`;
}

function fmtTimeRange(start, end) {
  if (!start) return 'Dia inteiro';
  return end ? `${start} às ${end}` : start;
}

/** Valida 'DD/MM/AAAA' ou 'AAAA-MM-DD' e devolve 'AAAA-MM-DD' ou null */
function parseDateInput(v) {
  if (!v) return null;
  v = String(v).trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (m) v = `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (dt.getUTCMonth() !== +m[2] - 1) return null;
  return v;
}

function parseTimeInput(v) {
  if (!v) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v).trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

module.exports = {
  TZ,
  MONTHS,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  nowIso,
  todayLocal,
  nowTimeLocal,
  localToIso,
  isoToLocalInput,
  fmtDate,
  fmtDateTime,
  fmtLongDate,
  fmtTimeRange,
  parseDateInput,
  parseTimeInput,
};

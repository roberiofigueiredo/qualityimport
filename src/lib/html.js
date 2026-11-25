const sanitizeHtml = require('sanitize-html');

/** Limpa o texto formatado vindo do editor, mantendo apenas formatação segura. */
function cleanHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr', 'div', 'span'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      b: 'strong',
      i: 'em',
    },
  }).trim();
}

function stripHtml(html) {
  return sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}

/** Normaliza número de WhatsApp para o formato do wa.me (somente dígitos, com DDI 55). */
function waNumber(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) return '55' + d;
  return d;
}

function waLink(number, message) {
  const n = waNumber(number);
  if (!n) return '';
  return `https://wa.me/${n}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

function telLink(v) {
  const d = String(v || '').replace(/[^\d+]/g, '');
  return d ? `tel:${d}` : '';
}

function safeUrl(v) {
  const s = String(v || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

module.exports = { cleanHtml, stripHtml, waNumber, waLink, telLink, safeUrl };

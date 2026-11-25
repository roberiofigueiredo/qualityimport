const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { nowIso } = require('./dates');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ATTACHMENT_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
];
const IMAGE_FIELDS = new Set(['capa', 'fotos', 'logo', 'imagem_destaque']);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 60 },
  fileFilter: (req, file, cb) => {
    const allowed = IMAGE_FIELDS.has(file.fieldname) ? IMAGE_TYPES : ATTACHMENT_TYPES;
    if (!allowed.includes(file.mimetype)) {
      req.uploadErrors = req.uploadErrors || [];
      req.uploadErrors.push(`Arquivo "${file.originalname}" não é de um tipo permitido.`);
      return cb(null, false);
    }
    cb(null, true);
  },
});

/** Registra um arquivo enviado (multer) no banco e devolve seu id. */
function registerFile(db, file, ownerType, ownerId, userId) {
  const id = crypto.randomBytes(12).toString('hex');
  db.prepare(
    `INSERT INTO files (id, original_name, mime, size, storage_name, owner_type, owner_id, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, Buffer.from(file.originalname, 'latin1').toString('utf8'), file.mimetype, file.size, file.filename, ownerType, ownerId, userId, nowIso());
  return id;
}

function filePath(row) {
  return path.join(UPLOAD_DIR, row.storage_name);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

module.exports = { upload, registerFile, filePath, humanSize, UPLOAD_DIR, IMAGE_TYPES };

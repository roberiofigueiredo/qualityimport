const { nowIso } = require('./dates');

const ACTION_LABELS = {
  'login': 'Entrou no sistema',
  'logout': 'Saiu do sistema',
  'senha.definida': 'Definiu a senha',
  'senha.redefinicao_solicitada': 'Solicitou redefinição de senha',
  'usuario.criado': 'Cadastrou usuário',
  'usuario.convite_enviado': 'Enviou convite',
  'usuario.perfil_alterado': 'Alterou perfil de permissão',
  'usuario.dados_alterados': 'Alterou dados do usuário',
  'usuario.redefinicao_iniciada': 'Iniciou redefinição de senha',
  'usuario.desativado': 'Desativou conta',
  'usuario.reativado': 'Reativou conta',
  'filial.criada': 'Cadastrou filial',
  'filial.alterada': 'Alterou filial',
  'setor.criado': 'Cadastrou setor',
  'setor.alterado': 'Alterou setor',
  'categoria.criada': 'Cadastrou categoria',
  'categoria.alterada': 'Alterou categoria',
  'linha.alterada': 'Alterou linha de produtos',
  'linha.criada': 'Cadastrou linha de produtos',
  'configuracoes.alteradas': 'Alterou configurações do site',
  'informativo.criado': 'Criou informativo',
  'informativo.alterado': 'Editou informativo',
  'informativo.publicado': 'Publicou informativo',
  'informativo.agendado': 'Agendou informativo',
  'informativo.arquivado': 'Arquivou informativo',
  'informativo.leitura_confirmada': 'Confirmou leitura',
  'album.criado': 'Criou álbum',
  'album.alterado': 'Editou álbum',
  'album.publicado': 'Publicou álbum',
  'album.agendado': 'Agendou álbum',
  'album.arquivado': 'Arquivou álbum',
  'album.fotos_adicionadas': 'Adicionou fotos',
  'album.foto_removida': 'Removeu foto',
  'evento.criado': 'Criou evento',
  'evento.alterado': 'Alterou evento',
  'evento.publicado': 'Publicou evento',
  'evento.agendado': 'Agendou evento',
  'evento.cancelado': 'Cancelou evento',
  'evento.arquivado': 'Arquivou evento',
};

function audit(db, userId, action, entityType, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId || null,
    action,
    entityType || null,
    entityId == null ? null : String(entityId),
    details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
    nowIso()
  );
}

module.exports = { audit, ACTION_LABELS };

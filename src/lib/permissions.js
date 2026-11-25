// Perfis: colaborador < marketing < ti
const ROLE_LABELS = { colaborador: 'Colaborador', marketing: 'Marketing', ti: 'Administrador de TI' };
const ROLES = Object.keys(ROLE_LABELS);

const CAPS = {
  // painel editorial (informativos, galeria, calendário)
  editorial: ['marketing', 'ti'],
  // usuários, perfis, filiais, setores, configurações, histórico
  admin: ['ti'],
};

function can(user, cap) {
  return !!user && user.status === 'ativo' && (CAPS[cap] || []).includes(user.role);
}

module.exports = { ROLE_LABELS, ROLES, can };

/**
 * Cliente da API. Único ponto do front que conhece a URL do backend e o token.
 *
 * O token fica em localStorage: o front está na Vercel e a API em outro domínio
 * (wa-api.sobreip.com.br), então cookie de sessão não serve — seria cross-site.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3020';
const CHAVE_TOKEN = 'wam_token';

export const token = {
  ler: () => localStorage.getItem(CHAVE_TOKEN),
  gravar: (t: string) => localStorage.setItem(CHAVE_TOKEN, t),
  limpar: () => localStorage.removeItem(CHAVE_TOKEN),
};

export class ErroApi extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function req<T>(caminho: string, opcoes: RequestInit = {}): Promise<T> {
  const t = token.ler();
  const resp = await fetch(BASE + caminho, {
    ...opcoes,
    headers: {
      ...(opcoes.body && !(opcoes.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...opcoes.headers,
    },
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // 401 = token vencido/inválido: limpa e deixa o roteador mandar para o login
    if (resp.status === 401) token.limpar();
    throw new ErroApi(resp.status, (dados as { erro?: string }).erro ?? `HTTP ${resp.status}`);
  }
  return dados as T;
}

// ------------------------------------------------------------------- tipos

export interface Usuario {
  id: string; email: string; nome: string | null;
  /** Só decide o que a interface mostra; a autorização real é refeita na API. */
  papel_global?: 'usuario' | 'admin';
}
export interface Grupo {
  id: number; nome: string; descricao: string | null;
  frequencia_coleta: string; ultima_coleta_em: string | null;
  papel: string; mensagens: number;
}
export interface Estatisticas {
  total: number;
  autores: Array<{ nome: string; mensagens: number }>;
  dias: Array<{ dia: string; mensagens: number }>;
  pico: Array<{ hora: number; mensagens: number }>;
  ranking: Array<{ nome: string; mensagens: number }>;
}
export interface ResultadoUpload {
  duplicado: boolean; upload_id: number; enviado_em?: string;
  plataforma?: string; formato_data?: string; data_ambigua?: boolean;
  avisos?: string[]; linhas_lidas?: number; mensagens_lidas?: number;
  mensagens_novas: number; mensagens_repetidas: number;
}
export interface Resumo {
  dia: string; mensagens: number; autores: number; resumo: string; doCache: boolean;
}
export interface Busca {
  pergunta: string; resposta: string;
  fontes: Array<{ bloco_id: number; inicio_em: string; fim_em: string; trecho: string; similaridade: number }>;
}
export interface Consentimento {
  id: number; versao_texto: string; texto: string; base_legal: string;
  canal: string | null; consentido_em: string; revogado_em: string | null; pessoa: string | null;
}
export interface SaudeColeta {
  grupo_id: number; nome: string;
  frequencia_coleta: 'diaria' | 'semanal' | 'manual';
  ultima_coleta_em: string | null; proxima_coleta_em: string | null;
  dias_sem_coleta: number | null; atrasado: boolean; nunca_coletado: boolean;
  lembrete_ativo: boolean; lembrete_destino: string | null; lembrete_enviado_em: string | null;
  consentimento_ok: boolean; mensagens: number;
}
export interface Instancia {
  id: number; rotulo: string; instancia_nome: string;
  numero_e164: string | null; perfil_nome: string | null;
  estado: 'desconectado' | 'qr_pendente' | 'conectando' | 'conectado' | 'sessao_morta' | 'erro';
  estado_motivo: string | null; estado_em: string | null;
  qr_base64: string | null; qr_contagem: number; qr_em: string | null;
  ultimo_evento_em: string | null; ultima_mensagem_em: string | null;
  reconexoes: number; pareada: boolean;
}
export interface GrupoRemoto {
  jid: string; nome: string; participantes: number | null;
  grupo_id: number | null; nome_local: string | null;
  monitorado: boolean; consentimento_ok: boolean;
}
export interface Alerta {
  id: number; tipo: string; severidade: number; titulo: string; detalhe: string | null;
  estado: 'novo' | 'visto' | 'resolvido'; criado_em: string;
  resumo: string | null; temperatura: number | null; sentimento: string | null;
  dados: {
    chamados?: Array<{ quem?: string; por_quem?: string; trecho?: string; respondido?: boolean }>;
    dores?: Array<{ tema?: string; descricao?: string; quem_relatou?: string }>;
    pendencias?: Array<{ o_que?: string; de_quem?: string; prazo?: string | null }>;
    proximo_passo?: string | null;
  } | null;
}

/** `tem_token` no lugar do token: o segredo nunca sai da API, nem mascarado. */
export interface Conexao {
  id: number; rotulo: string; provedor: string;
  endpoint: string | null; remetente: string | null;
  config: { template?: string; idioma?: string };
  status: 'desconectado' | 'conectado' | 'erro';
  erro_mensagem: string | null; erro_em: string | null;
  ultima_verificacao_em: string | null; ultimo_uso_em: string | null;
  tem_token: boolean; criado_em: string; atualizado_em: string;
}

// ------------------------------------------------------------------- rotas

const qs = (o: Record<string, string | number | null | undefined>) =>
  '?' + new URLSearchParams(
    Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]),
  );

export const api = {
  login: (email: string, senha: string) =>
    req<{ token: string; usuario: Usuario }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, senha }),
    }),
  eu: () => req<{ usuario: Usuario }>('/auth/eu'),
  grupos: () => req<{ grupos: Grupo[] }>('/grupos'),

  estatisticas: (grupo: number, inicio?: string, fim?: string) =>
    req<Estatisticas>('/stats/resumo' + qs({ grupo_id: grupo, inicio, fim })),

  mencoes: (grupo: number, termo: string) =>
    req<{ termo: string; mensagens: number; ocorrencias: number }>(
      '/stats/mencoes' + qs({ grupo_id: grupo, termo })),

  enviarExport: async (grupo: number, arquivo: File, formatoData?: string) =>
    req<ResultadoUpload>('/upload' + qs({ grupo_id: grupo, nome: arquivo.name, formato_data: formatoData }), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: await arquivo.text(),
    }),

  uploads: (grupo: number) =>
    req<{ uploads: Array<Record<string, unknown>> }>('/uploads' + qs({ grupo_id: grupo })),

  resumo: (grupo: number, dia: string) => req<Resumo>('/resumo' + qs({ grupo_id: grupo, dia })),

  buscar: (grupo: number, pergunta: string) =>
    req<Busca>('/busca', { method: 'POST', body: JSON.stringify({ grupo_id: grupo, pergunta }) }),

  indexar: (grupo: number) =>
    req<{ blocos: number; tokens: number; usd: number | null }>(
      '/indexar' + qs({ grupo_id: grupo }), { method: 'POST' }),

  consentimentos: (grupo: number) =>
    req<{ consentimentos: Consentimento[] }>('/consentimentos' + qs({ grupo_id: grupo })),

  registrarConsentimento: (grupo: number, dados: { texto: string; versao_texto?: string; canal?: string }) =>
    req<{ consentimento: { id: number; consentido_em: string } }>('/consentimentos', {
      method: 'POST', body: JSON.stringify({ grupo_id: grupo, ...dados }),
    }),

  revogarConsentimento: (grupo: number, id: number) =>
    req<{ consentimento: { id: number; revogado_em: string }; consentimento_vigente: boolean }>(
      '/consentimentos/revogar', { method: 'POST', body: JSON.stringify({ grupo_id: grupo, id }) }),

  // ---- captura em tempo real (D8) ----------------------------------------
  instancia: () => req<{ instancia: Instancia | null; configurada: boolean }>('/captura/instancia'),

  criarInstancia: () =>
    req<{ instancia: Instancia }>('/captura/instancia', { method: 'POST' }),

  conectar: () =>
    req<{ qr: string | null; contagem?: number; estado: string }>('/captura/conectar', { method: 'POST' }),

  desconectarCaptura: () => req<{ estado: string }>('/captura/desconectar', { method: 'POST' }),

  gruposRemotos: () => req<{ grupos: GrupoRemoto[] }>('/captura/grupos'),

  vincularGrupo: (grupo: number, wa_jid: string, wa_nome?: string) =>
    req<{ grupo: unknown }>('/captura/vincular', {
      method: 'POST', body: JSON.stringify({ grupo_id: grupo, wa_jid, wa_nome }),
    }),

  desvincularGrupo: (grupo: number) =>
    req<{ grupo: unknown }>('/captura/desvincular', {
      method: 'POST', body: JSON.stringify({ grupo_id: grupo }),
    }),

  alertas: (grupo: number) => req<{ alertas: Alerta[] }>('/alertas' + qs({ grupo_id: grupo })),

  marcarAlerta: (grupo: number, id: number, estado: string) =>
    req<{ alerta: unknown }>('/alertas/estado', {
      method: 'POST', body: JSON.stringify({ grupo_id: grupo, id, estado }),
    }),

  usoIA: (grupo: number) =>
    req<{ uso: Array<{ dia: string; chamadas: number; usd: number }>; teto: number }>(
      '/analise/uso' + qs({ grupo_id: grupo })),

  // ---- coleta assistida --------------------------------------------------
  saudeColeta: () => req<{ grupos: SaudeColeta[] }>('/coleta/saude'),

  salvarColeta: (grupo: number, dados: {
    frequencia_coleta: string; lembrete_ativo: boolean; lembrete_destino?: string | null;
  }) => req<{ grupo: SaudeColeta }>('/coleta/config', {
    method: 'POST', body: JSON.stringify({ grupo_id: grupo, ...dados }),
  }),

  enviarLembrete: (grupo: number, destino?: string) =>
    req<{ enviado: boolean; destino: string }>('/coleta/lembrete', {
      method: 'POST', body: JSON.stringify({ grupo_id: grupo, destino }),
    }),

  lembretes: (grupo: number) =>
    req<{ lembretes: Array<{ id: number; destino: string; status: string; erro: string | null; criado_em: string }> }>(
      '/coleta/lembretes' + qs({ grupo_id: grupo })),

  // ---- canal de aviso (admin do painel) ----------------------------------
  conexoes: () => req<{ conexoes: Conexao[] }>('/conexoes'),

  salvarConexao: (dados: {
    id?: number; rotulo: string; endpoint: string; remetente?: string;
    template?: string; idioma?: string; token?: string;
  }) => req<{ conexao: Conexao }>('/conexoes', { method: 'POST', body: JSON.stringify(dados) }),

  testarConexao: (id: number) =>
    req<{ ok: boolean; status: string }>('/conexoes/testar' + qs({ id }), { method: 'POST' }),

  removerConexao: (id: number) =>
    req<{ conexao: Conexao }>('/conexoes/remover' + qs({ id }), { method: 'POST' }),
};

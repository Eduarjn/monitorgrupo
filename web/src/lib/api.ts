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

export interface Usuario { id: string; email: string; nome: string | null }
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
};

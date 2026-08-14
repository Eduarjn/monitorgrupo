/**
 * whatsapp-monitor — Fase 1: tipos compartilhados entre /api e /web.
 *
 * Espelham `db/schema.sql`. Quando o schema mudar, este arquivo muda junto —
 * é a única fonte de verdade dos dois lados.
 */

// ---------------------------------------------------------------- enumerações

/** Cadência da coleta (decisão D3). O export em si continua manual. */
export type FrequenciaColeta = 'diaria' | 'semanal' | 'manual';

export type PapelNoGrupo = 'leitor' | 'gestor' | 'admin';

export type PlataformaExport = 'ios' | 'android' | 'desconhecida';

/**
 * Formato de data do export (risco 1.1). O WhatsApp não informa qual usou:
 * depende do idioma do celular de quem exportou. `DMY` = 03/08 é 3 de agosto;
 * `MDY` = 03/08 é 8 de março. Errar aqui desloca todo o histórico em silêncio.
 */
export type FormatoData = 'DMY' | 'MDY';

export type StatusUpload = 'pendente' | 'processando' | 'concluido' | 'erro';

/**
 * `audio_transcrito` já existe mesmo com áudio fora do escopo inicial (D1),
 * para que plugar a Fase 4 depois não exija migração.
 * `midia` é a mensagem que referencia um arquivo ainda não transcrito.
 * `sistema` é "Fulano entrou", "as mensagens são criptografadas" etc. — nunca
 * deve entrar nas estatísticas de participação.
 */
export type TipoMensagem = 'texto' | 'audio_transcrito' | 'midia' | 'sistema';

// ------------------------------------------------------------------- entidades

export interface Grupo {
  id: number;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  frequencia_coleta: FrequenciaColeta;
  ultima_coleta_em: string | null;   // ISO 8601
  proxima_coleta_em: string | null;
  criado_em: string;
  criado_por: string | null;         // uuid
}

export interface GrupoAcesso {
  grupo_id: number;
  user_id: string;
  papel: PapelNoGrupo;
  criado_em: string;
}

/**
 * Identidade real, separada da grafia (risco 1.3). O export traz o nome como
 * está na agenda de quem exportou, então a mesma pessoa aparece como "João",
 * "João Silva" ou "+55 19 99999-9999" dependendo do celular de origem.
 */
export interface Pessoa {
  id: number;
  nome_exibicao: string;
  telefone_e164: string | null;
  observacao: string | null;
  criado_em: string;
}

/** Uma grafia observada nos exports, ligada a uma pessoa. */
export interface PessoaAlias {
  id: number;
  pessoa_id: number;
  alias: string;
  grupo_id: number | null;   // null = alias válido em qualquer grupo
  criado_em: string;
}

export interface Upload {
  id: number;
  grupo_id: number;
  arquivo_nome: string;
  arquivo_hash: string;      // sha256 — evita reprocessar o MESMO arquivo
  tamanho_bytes: number | null;

  plataforma: PlataformaExport | null;
  idioma: string | null;
  formato_data: FormatoData | null;
  fuso: string;
  /** true quando o usuário confirmou o formato ambíguo na tela de upload. */
  formato_confirmado: boolean;

  status: StatusUpload;
  erro: string | null;
  linhas_lidas: number | null;
  mensagens_novas: number | null;
  mensagens_repetidas: number | null;

  enviado_por: string | null;
  criado_em: string;
  processado_em: string | null;
}

export interface Mensagem {
  id: number;
  grupo_id: number;
  upload_id: number | null;

  /** Autor exatamente como veio no arquivo. Nunca sobrescrever. */
  autor_raw: string | null;
  /** Preenchido pela conciliação de identidade, depois da ingestão. */
  pessoa_id: number | null;

  enviada_em: string;
  conteudo: string;
  tipo: TipoMensagem;
  /** Nome do arquivo citado na linha, quando houver (risco 1.2). */
  midia_arquivo: string | null;

  /** hash(grupo + timestamp + autor + conteúdo) — dedup por mensagem (D3). */
  hash_mensagem: string;
  criado_em: string;
}

/**
 * Saída do parser (Fase 2): ainda sem id, sem pessoa_id e sem upload_id.
 * O parser não conhece o banco — só transforma texto em estrutura.
 */
export type MensagemParseada = Pick<
  Mensagem,
  'autor_raw' | 'enviada_em' | 'conteudo' | 'tipo' | 'midia_arquivo'
>;

/**
 * Unidade de embedding (risco 1.5): NÃO é a mensagem. Mensagem de WhatsApp é
 * curta demais ("ok", "kkkk") e vetorizada isolada gera recuperação ruim.
 * O bloco é uma janela de conversa; `mensagem_ids` preserva a origem para que a
 * resposta do RAG possa citar trechos e datas.
 */
export interface Bloco {
  id: number;
  grupo_id: number;
  inicio_em: string;
  fim_em: string;
  texto: string;
  mensagem_ids: number[];
  embedding: number[] | null;   // 1536 dimensões (text-embedding-3-small)
  modelo: string | null;
  criado_em: string;
}

/** Registro por titular, revogável — não é um "aviso" só (risco 1.7). */
export interface Consentimento {
  id: number;
  grupo_id: number;
  pessoa_id: number | null;
  versao_texto: string;
  texto: string;
  base_legal: string;
  canal: string | null;
  consentido_em: string;
  revogado_em: string | null;
  registrado_por: string | null;
  criado_em: string;
}

export interface PoliticaRetencao {
  grupo_id: number;
  dias: number;
  atualizado_em: string;
}

// -------------------------------------------------------- retornos das análises

/** Resultado das estatísticas da Fase 3 — tudo isto sai de SQL, sem IA. */
export interface VolumePorAutor {
  pessoa_id: number | null;
  nome: string;
  mensagens: number;
}

export interface VolumePorDia {
  dia: string;          // YYYY-MM-DD
  mensagens: number;
}

export interface HorarioPico {
  hora: number;         // 0–23
  mensagens: number;
}

export interface ContagemMencoes {
  termo: string;
  ocorrencias: number;
  mensagens: number;    // nº de mensagens distintas que citam o termo
}

/** Resposta do RAG (Fase 5), sempre com as fontes que a embasaram. */
export interface RespostaBusca {
  pergunta: string;
  resposta: string;
  fontes: Array<{
    bloco_id: number;
    inicio_em: string;
    fim_em: string;
    trecho: string;
    similaridade: number;
  }>;
}

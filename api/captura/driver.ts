/**
 * Interface do provedor de captura.
 *
 * Mesma doutrina do `api/ai/provider.ts` (OpenAI ↔ Mock): a Evolution API fica
 * atrás de uma interface para que trocar por Z-API/Whapi — ou voltar atrás —
 * seja implementar seis métodos, não reescrever a ingestão.
 *
 * ⚠️ Este caminho é NÃO OFICIAL (Baileys sob o capô). Decisão do dono do projeto
 * em 17/08/2026, revertendo D2/D7 — ver docs/02-decisoes.md, D8. O risco real
 * documentado é banimento do número, inclusive sem enviar nada. Por isso a
 * regra de ouro deste módulo: **nunca enviar mensagem**. Não existe método de
 * envio nesta interface, e isso é proposital.
 */

/** Estado da sessão, normalizado entre provedores. */
export type EstadoInstancia =
  | 'desconectado'   // nunca pareada ou logout explícito
  | 'qr_pendente'    // QR na tela, esperando leitura
  | 'conectando'     // pareou, sincronizando
  | 'conectado'      // recebendo
  | 'sessao_morta'   // logout pelo celular / número banido — exige novo QR
  | 'erro';

export interface QrCode {
  /** data-URI PNG pronto para <img src>. */
  base64: string | null;
  contagem: number;
}

export interface EstadoConexao {
  estado: EstadoInstancia;
  motivo?: string;
  numero_e164?: string | null;
  perfil_nome?: string | null;
}

export interface GrupoRemoto {
  jid: string;
  nome: string;
  participantes: number | null;
}

/** Mensagem já normalizada — é o contrato que a ingestão consome. */
export interface MensagemCapturada {
  /** JID do grupo (…@g.us). Mensagem 1:1 nunca chega aqui. */
  grupo_jid: string;
  /** id da mensagem no WhatsApp (data.key.id) — idempotência. */
  wa_msg_id: string;
  /** JID de quem enviou (key.participant). */
  autor_jid: string | null;
  /** Nome de exibição no celular do remetente. Pode mudar a qualquer momento. */
  autor_nome: string | null;
  enviada_em: Date;
  conteudo: string;
  tipo: 'texto' | 'midia' | 'sistema' | 'audio_transcrito';
  /** Nome do arquivo de mídia, quando houver. */
  midia_arquivo: string | null;
  /** stanzaId da mensagem citada — permite reconstruir a linha da conversa. */
  respondendo_a: string | null;
  /** JIDs mencionados: alimenta o gatilho de menção direta. */
  mencionados: string[];
  /** true quando foi o próprio número monitorado que enviou. */
  propria: boolean;
}

export interface EventoNormalizado {
  tipo: 'mensagem' | 'conexao' | 'qr' | 'grupo' | 'outro';
  /** id estável do evento, para idempotência. */
  id: string;
  mensagem?: MensagemCapturada;
  conexao?: EstadoConexao;
  qr?: QrCode;
}

export interface DriverCaptura {
  readonly nome: string;
  criarInstancia(nome: string): Promise<{ token: string; uuid: string | null }>;
  registrarWebhook(nome: string, url: string, segredo: string): Promise<void>;
  conectar(nome: string): Promise<QrCode | EstadoConexao>;
  estado(nome: string): Promise<EstadoConexao>;
  desconectar(nome: string): Promise<void>;
  remover(nome: string): Promise<void>;
  listarGrupos(nome: string): Promise<GrupoRemoto[]>;
  /** Puro: sem rede, sem banco. É o que os testes exercitam. */
  normalizarEvento(corpo: unknown): EventoNormalizado | null;
}

/** Um JID de grupo sempre termina em @g.us. É assim que separamos de 1:1. */
export const ehGrupo = (jid: string | null | undefined): boolean =>
  typeof jid === 'string' && jid.endsWith('@g.us');

/** '5519999999999@s.whatsapp.net' -> '5519999999999'. Preserva @lid como veio. */
export function telefoneDoJid(jid: string | null | undefined): string | null {
  if (!jid || typeof jid !== 'string') return null;
  if (jid.endsWith('@lid')) return null;          // identificador opaco, não é telefone
  const numero = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{10,15}$/.test(numero) ? numero : null;
}

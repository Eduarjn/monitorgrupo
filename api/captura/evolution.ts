/**
 * Driver da Evolution API 2.3.7 (self-hosted, wrapper de Baileys).
 *
 * Roda em 127.0.0.1:8080 no mesmo servidor — o tráfego nunca sai da máquina,
 * que é a premissa do projeto inteiro.
 *
 * ⚠️ VERSÃO FIXADA. A partir da 2.4.0 toda instância exige ativação contra o
 * servidor de licenciamento e devolve 503 LICENSE_REQUIRED em tudo. A tag é
 * `evoapicloud/evolution-api:2.3.7` e o upgrade é decisão humana.
 *
 * ⚠️ Os nomes de campo vieram do código-fonte da 2.3.7; nenhum payload real foi
 * capturado ao vivo. `normalizarEvento` é defensiva de propósito: campo
 * faltando devolve null em vez de estourar.
 */

import { timingSafeEqual } from 'node:crypto';
import { ehGrupo, type DriverCaptura, type EstadoConexao, type EstadoInstancia,
         type EventoNormalizado, type GrupoRemoto, type MensagemCapturada,
         type QrCode } from './driver.ts';

const TIMEOUT_MS = 20_000;

/**
 * Erro com status HTTP embutido. O `rotear()` do servidor já respeita `.status`
 * do que for lançado, então isto faz a mensagem chegar ao usuário em vez de
 * virar o "Erro interno." genérico que o handler de 500 produz.
 */
export class ErroEvolution extends Error {
  readonly status: number;
  constructor(msg: string, status = 502) {
    super(msg);
    this.status = status;
  }
}

function traduzirEstado(bruto: string | undefined): EstadoInstancia {
  switch ((bruto ?? '').toLowerCase()) {
    case 'open': return 'conectado';
    case 'connecting': return 'conectando';
    case 'close': return 'desconectado';
    default: return 'erro';
  }
}

/** O Baileys entrega o texto em lugares diferentes conforme o tipo. */
function extrairTexto(m: Record<string, unknown> | undefined): string {
  if (!m) return '';
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : undefined);
  return s(m.conversation)
    || s(obj(m.extendedTextMessage)?.text)
    || s(obj(m.imageMessage)?.caption)
    || s(obj(m.videoMessage)?.caption)
    || s(obj(m.documentMessage)?.caption)
    || s(obj(obj(m.ephemeralMessage)?.message)?.conversation)
    || '';
}

const TIPOS_MIDIA = new Set([
  'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
  'stickerMessage', 'ptvMessage',
]);

export class EvolutionDriver implements DriverCaptura {
  readonly nome = 'evolution';

  // ⚠️ Campos declarados e atribuídos à mão, NÃO como parameter property
  // (`constructor(private readonly x: string)`). O esbuild aceita aquela forma,
  // mas o `node --experimental-strip-types` — que roda `npm test` e o
  // conferir-payload — recusa com ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. O bundle
  // compilaria e os testes quebrariam, que é o pior dos dois mundos.
  private readonly endpoint: string;
  /** apikey GLOBAL — necessária para criar instância e listar. */
  private readonly apikeyGlobal: string;

  constructor(endpoint: string, apikeyGlobal: string) {
    this.endpoint = endpoint;
    this.apikeyGlobal = apikeyGlobal;
  }

  private async chamar<T>(
    caminho: string, metodo = 'GET', corpo?: unknown, apikey?: string,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.endpoint.replace(/\/+$/, '') + caminho, {
        method: metodo,
        headers: {
          'Content-Type': 'application/json',
          // Header `apikey` minúsculo, sem Bearer.
          apikey: apikey ?? this.apikeyGlobal,
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // `fetch failed` sozinho não diz nada, e o handler de 500 do servidor o
      // transforma em "Erro interno." — que foi exatamente o que confundiu no
      // primeiro teste real. A causa quase sempre é o container fora do ar.
      const causa = (e as { cause?: { code?: string } }).cause?.code
                 ?? (e as Error).name;
      const fora = causa === 'ECONNREFUSED' || causa === 'ENOTFOUND'
                || causa === 'EHOSTUNREACH' || causa === 'ECONNRESET';
      throw new ErroEvolution(
        fora
          ? `A Evolution não respondeu em ${this.endpoint}. O container está no ar? ` +
            '(docker compose ps em /opt/evolution)'
          : causa === 'TimeoutError'
            ? `A Evolution não respondeu em ${TIMEOUT_MS / 1000}s.`
            : `Falha ao falar com a Evolution (${causa}).`,
        503,
      );
    }
    const texto = await resp.text();
    let dados: unknown;
    try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { bruto: texto.slice(0, 300) }; }

    if (!resp.ok) {
      const msg = (dados as { message?: unknown; error?: unknown })?.message
               ?? (dados as { error?: unknown })?.error ?? `HTTP ${resp.status}`;
      if (resp.status === 503) {
        throw new ErroEvolution(
          'A Evolution respondeu 503 (licença). A imagem precisa ficar fixada em 2.3.7.', 503);
      }
      throw new ErroEvolution(
        `Evolution: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, 502);
    }
    return dados as T;
  }

  async criarInstancia(nome: string): Promise<{ token: string; uuid: string | null }> {
    const r = await this.chamar<{ hash?: string | { apikey?: string };
                                  instance?: { instanceId?: string } }>(
      '/instance/create', 'POST', {
        instanceName: nome,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        // groupsIgnore FALSE é o ponto do projeto: com true o handler dá
        // `continue` e mensagem de grupo NUNCA chega ao webhook.
        groupsIgnore: false,
        // Observar sem alterar o estado das conversas de quem usa o celular.
        readMessages: false,
        readStatus: false,
        alwaysOnline: false,
        // syncFullHistory TRUE mesmo sem querer o dump: com false o Baileys 7.x
        // rejeita todos os sync types e messages.upsert nunca chega — conecta e
        // não captura nada. Não assinamos MESSAGES_SET, então o dump fica lá.
        syncFullHistory: true,
      });
    const token = typeof r.hash === 'string' ? r.hash : (r.hash?.apikey ?? '');
    return { token, uuid: r.instance?.instanceId ?? null };
  }

  async registrarWebhook(nome: string, url: string, segredo: string): Promise<void> {
    // Corpo ANINHADO — é o que o WebhookController lê na 2.3.7. A doc publicada
    // mostra o formato plano, que é rejeitado EM SILÊNCIO.
    await this.chamar(`/webhook/set/${encodeURIComponent(nome)}`, 'POST', {
      webhook: {
        enabled: true,
        url,
        headers: { 'x-captura-segredo': segredo, 'Content-Type': 'application/json' },
        // byEvents FALSE é obrigatório: com true a Evolution posta em
        // /captura/webhook/messages-upsert, que o roteador (match exato) não
        // reconhece — e 404 aborta o retry, então a mensagem sumiria calada.
        byEvents: false,
        base64: false,
        events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT',
                 'GROUPS_UPSERT', 'GROUP_UPDATE'],
      },
    });

    // Confere em vez de confiar no 200 — se o formato foi rejeitado, nada chega.
    const conferido = await this.chamar<{ enabled?: boolean; events?: string[] }>(
      `/webhook/find/${encodeURIComponent(nome)}`);
    if (!conferido?.enabled || !(conferido.events ?? []).includes('MESSAGES_UPSERT')) {
      throw new ErroEvolution('A Evolution aceitou o POST mas não gravou o webhook. ' +
                              'Nenhuma mensagem chegaria — confira a versão da imagem.', 502);
    }
  }

  async conectar(nome: string): Promise<QrCode | EstadoConexao> {
    // Não é idempotente: se já estiver conectada devolve o estado, não um QR.
    const r = await this.chamar<{ base64?: string; count?: number;
                                  instance?: { state?: string } }>(
      `/instance/connect/${encodeURIComponent(nome)}`);
    if (r.base64) return { base64: r.base64, contagem: r.count ?? 0 };
    return { estado: traduzirEstado(r.instance?.state) };
  }

  async estado(nome: string): Promise<EstadoConexao> {
    const r = await this.chamar<{ instance?: { state?: string; owner?: string; profileName?: string } }>(
      `/instance/connectionState/${encodeURIComponent(nome)}`);
    return {
      estado: traduzirEstado(r.instance?.state),
      numero_e164: r.instance?.owner?.split('@')[0] ?? null,
      perfil_nome: r.instance?.profileName ?? null,
    };
  }

  /** DELETE, não POST — vários tutoriais em PT-BR erram isso. */
  async desconectar(nome: string): Promise<void> {
    await this.chamar(`/instance/logout/${encodeURIComponent(nome)}`, 'DELETE');
  }

  async remover(nome: string): Promise<void> {
    await this.chamar(`/instance/delete/${encodeURIComponent(nome)}`, 'DELETE');
  }

  async listarGrupos(nome: string): Promise<GrupoRemoto[]> {
    // getParticipants é obrigatório em 2.x — sem ele a chamada falha.
    const r = await this.chamar<Array<{ id?: string; subject?: string; size?: number }>>(
      `/group/fetchAllGroups/${encodeURIComponent(nome)}?getParticipants=false`);
    return (Array.isArray(r) ? r : [])
      .filter((g) => ehGrupo(g.id))
      .map((g) => ({ jid: g.id as string, nome: g.subject ?? '(sem nome)', participantes: g.size ?? null }));
  }

  normalizarEvento(corpo: unknown): EventoNormalizado | null {
    const raiz = corpo as Record<string, unknown> | null;
    if (!raiz || typeof raiz !== 'object') return null;

    const evento = String(raiz.event ?? '').toLowerCase();
    const dados = (raiz.data ?? {}) as Record<string, unknown>;

    if (evento === 'qrcode.updated') {
      const qr = (dados.qrcode ?? dados) as Record<string, unknown>;
      return {
        tipo: 'qr',
        id: `qr:${String(qr.count ?? 0)}:${String(raiz.date_time ?? '')}`,
        qr: { base64: typeof qr.base64 === 'string' ? qr.base64 : null,
              contagem: Number(qr.count ?? 0) },
      };
    }

    if (evento === 'connection.update') {
      const estado = traduzirEstado(String(dados.state ?? dados.connection ?? ''));
      const motivo = dados.statusReason != null ? String(dados.statusReason) : undefined;
      return {
        tipo: 'conexao',
        id: `conn:${estado}:${String(raiz.date_time ?? '')}`,
        // 401 do Baileys = loggedOut: sessão morta, só QR novo resolve.
        conexao: { estado: motivo === '401' ? 'sessao_morta' : estado, motivo },
      };
    }

    if (evento === 'messages.upsert') {
      const m = this.normalizarMensagem(dados);
      if (!m) return null;
      return { tipo: 'mensagem', id: `msg:${m.wa_msg_id}`, mensagem: m };
    }

    if (evento.startsWith('groups.') || evento.startsWith('group.')) {
      return { tipo: 'grupo', id: `grp:${String(raiz.date_time ?? '')}` };
    }

    return { tipo: 'outro', id: `${evento}:${String(raiz.date_time ?? '')}` };
  }

  /** Público para os testes exercitarem sem montar o envelope inteiro. */
  normalizarMensagem(dados: Record<string, unknown>): MensagemCapturada | null {
    const key = (dados.key ?? {}) as Record<string, unknown>;
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
    // PRIMEIRO PORTÃO LGPD: só grupo. 1:1 é descartado antes de qualquer coisa.
    if (!ehGrupo(remoteJid)) return null;

    const waMsgId = typeof key.id === 'string' ? key.id : '';
    if (!waMsgId) return null;

    const msg = (dados.message ?? undefined) as Record<string, unknown> | undefined;
    const tipoBruto = String(dados.messageType ?? '');
    const texto = extrairTexto(msg);

    const ctxDireto = (dados.contextInfo ?? {}) as Record<string, unknown>;
    const ctxAninhado = ((msg?.extendedTextMessage as Record<string, unknown> | undefined)
                         ?.contextInfo ?? {}) as Record<string, unknown>;
    const mencionados = [
      ...(Array.isArray(ctxDireto.mentionedJid) ? ctxDireto.mentionedJid : []),
      ...(Array.isArray(ctxAninhado.mentionedJid) ? ctxAninhado.mentionedJid : []),
    ].filter((x): x is string => typeof x === 'string');

    const respondendoA = (typeof ctxDireto.stanzaId === 'string' ? ctxDireto.stanzaId : null)
                      ?? (typeof ctxAninhado.stanzaId === 'string' ? ctxAninhado.stanzaId : null);

    const epoch = Number(dados.messageTimestamp ?? 0);
    if (!Number.isFinite(epoch) || epoch <= 0) return null;

    const ehMidia = TIPOS_MIDIA.has(tipoBruto);
    const tipo: MensagemCapturada['tipo'] =
      tipoBruto === 'protocolMessage' || tipoBruto === 'senderKeyDistributionMessage'
        ? 'sistema' : ehMidia ? 'midia' : 'texto';

    if (tipo === 'texto' && !texto.trim()) return null;   // reação, recibo, ruído

    const midiaNome = ehMidia
      ? String(((msg?.[tipoBruto] as Record<string, unknown> | undefined)?.fileName) ?? '') || null
      : null;

    return {
      grupo_jid: remoteJid,
      wa_msg_id: waMsgId,
      // A migração LID faz o participant vir como @lid; participantAlt é o
      // caminho de reconciliação que a 2.3.7 expõe.
      autor_jid: typeof key.participant === 'string' ? key.participant
               : typeof key.participantAlt === 'string' ? key.participantAlt : null,
      autor_nome: typeof dados.pushName === 'string' ? dados.pushName : null,
      enviada_em: new Date(epoch * 1000),
      conteudo: texto,
      tipo,
      midia_arquivo: midiaNome,
      respondendo_a: respondendoA,
      mencionados,
      propria: key.fromMe === true,
    };
  }
}

/**
 * Confere o segredo do webhook em tempo constante.
 *
 * A Evolution 2.3.7 não assina o corpo (não há HMAC). A defesa é em camadas: a
 * rota não é exposta pelo nginx (a Evolution posta direto em 127.0.0.1), e este
 * header é o segundo controle.
 */
export function segredoConfere(recebido: string | undefined, esperado: string): boolean {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

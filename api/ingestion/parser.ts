/**
 * whatsapp-monitor — Fase 2: parser do .txt exportado do WhatsApp.
 *
 * A peça de maior risco do projeto: o formato varia entre iOS e Android, entre
 * idiomas E entre versões do app. Estratégia (conforme combinado):
 *
 *   • array de validadores — cada linha é testada contra as regexes em ordem;
 *     a primeira que casar define o formato da linha;
 *   • buffer/acumulador para mensagens multilinha — linha sem timestamp é
 *     continuação da mensagem anterior;
 *   • streaming — o parser consome um iterável de LINHAS (alimentável pelo
 *     readline do Node), nunca o arquivo inteiro em memória;
 *   • o formato da data (DMY×MDY, risco 1.1) é resolvido NO FIM: durante a
 *     leitura guardamos os campos crus, e só materializamos o timestamp quando
 *     o conjunto inteiro já revelou (ou não) o formato.
 *
 * O parser NÃO conhece o banco. Ele devolve mensagens estruturadas + metadados;
 * quem insere é a fase de ingestão.
 *
 * Diferenças em relação às regexes combinadas no plano (todas necessárias em
 * exports reais):
 *   • dia/mês com 1 dígito ("8/3/26" — padrão en-US) e vírgula após a data;
 *   • hora com AM/PM, inclusive com U+202F (narrow no-break space) antes do
 *     sufixo — é o que o iOS gera em inglês;
 *   • marcas invisíveis de direção (U+200E etc.) no começo da linha e dos
 *     campos — iOS espalha isso pelo arquivo;
 *   • separador Android pode ser hífen, en-dash ou em-dash.
 */

import type { FormatoData, MensagemParseada, PlataformaExport, TipoMensagem } from '../../shared/types.ts';
import { hashMensagem } from './dedup.ts';

// ----------------------------------------------------------------- interfaces

export interface MensagemIngerida extends MensagemParseada {
  hash_mensagem: string;
}

export interface OpcoesParse {
  /** Força o formato da data quando o arquivo é ambíguo (todos os valores ≤ 12). */
  formatoData?: FormatoData;
  /** Offset do fuso em que o celular estava. Padrão: -03:00 (America/Sao_Paulo). */
  offsetFuso?: string;
  /**
   * false (padrão): mensagens de mídia sem arquivo ("<Mídia omitida>") são
   * MANTIDAS como tipo 'midia' com conteúdo vazio — elas contam nas
   * estatísticas de participação (Fase 3) e são baratas de guardar.
   * true: descarta essas linhas (não recomendado; ver docs/02-decisoes.md).
   */
  descartarMidiaSemArquivo?: boolean;
}

export interface MetaParse {
  plataforma: PlataformaExport;
  formatoDataDetectado: FormatoData | 'ambiguo';
  formatoDataUsado: FormatoData;
  linhasLidas: number;
  totalMensagens: number;
  porTipo: Record<TipoMensagem, number>;
  descartadas: number;
  avisos: string[];
}

export interface ResultadoParse {
  mensagens: MensagemIngerida[];
  meta: MetaParse;
}

// ------------------------------------------------------------------- regexes

// iOS:     [03/08/2026 09:12:45] Autor: texto   |   [8/3/26, 9:12:45 PM] ...
const RE_IOS =
  /^\[(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\]\s?(.*)$/;

// Android: 03/08/2026 09:12 - Autor: texto     |   8/3/26, 9:12 PM - ...
const RE_ANDROID =
  /^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\s[-–—]\s(.*)$/;

// "Autor: conteúdo" — não-guloso até o PRIMEIRO ": " (autor não contém ':').
const RE_AUTOR = /^(.+?):\s([\s\S]*)$/;

// Mídia sem arquivo (export "sem mídia"). Comparação exata após limpeza.
const MARCADORES_MIDIA = new Set(
  [
    '<mídia omitida>', '<midia omitida>', '<media omitted>',
    'imagem ocultada', 'image omitted',
    'áudio ocultado', 'audio ocultado', 'audio omitted',
    'vídeo omitido', 'video omitido', 'video omitted',
    'figurinha omitida', 'sticker omitted',
    'documento omitido', 'document omitted',
    'gif omitido', 'gif omitted',
    'null',
  ],
);

// Mídia COM arquivo (export "com mídia") — daqui sai `midia_arquivo` (risco 1.2).
const RE_ANEXO_ANDROID = /^(.+?)\s\((?:arquivo anexado|file attached)\)$/i;
const RE_ANEXO_IOS = /^<(?:anexado|attached):\s*(.+?)>$/i;

// Frases de sistema que VÊM com "Autor:" no iOS (o "autor" é o nome do grupo).
// Sem isto, "Equipe: ‎As mensagens são protegidas..." viraria mensagem de texto.
const RE_SISTEMA = new RegExp(
  [
    'criptografia de ponta a ponta', 'end-to-end encrypted',
    'criou o grupo', 'created group', 'created this group',
    'adicionou', 'added you', ' added ',
    'saiu', ' left$', 'removeu', 'removed',
    'entrou usando o link', 'joined using', 'entrou pelo link',
    'mudou o nome do grupo', 'changed the subject', 'mudou a descrição',
    'changed this group', 'alterou o ícone', "changed this group's icon",
    'mudou para', 'agora é admin', "you're now an admin",
    'as mensagens temporárias', 'disappearing messages',
    'ligação de voz', 'ligação de vídeo', 'missed voice call', 'missed video call',
  ].join('|'),
  'i',
);

// ------------------------------------------------------------------ limpeza

// BOM + marcas de direção que o WhatsApp espalha (iOS principalmente).
const RE_INVISIVEIS = /[‎‏‪-‮⁦-⁩﻿]/g;

function limpar(s: string): string {
  return s.replace(RE_INVISIVEIS, '').replace(/[  ]/g, ' ');
}

// ------------------------------------------------------------- interpretação

interface Bruta {
  dataRaw: string;
  horaRaw: string;
  autorRaw: string;   // '' = sistema
  linhas: string[];   // conteúdo acumulado (multilinha)
  plataforma: PlataformaExport;
}

function interpretarHora(horaRaw: string): { h: number; m: number; s: number } {
  const m = horaRaw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp])?/);
  if (!m) return { h: 0, m: 0, s: 0 };
  let h = Number(m[1]);
  const sufixo = m[4]?.toLowerCase();
  if (sufixo === 'p' && h !== 12) h += 12;
  if (sufixo === 'a' && h === 12) h = 0;
  return { h, m: Number(m[2]), s: Number(m[3] ?? 0) };
}

function interpretarData(dataRaw: string, formato: FormatoData): { ano: number; mes: number; dia: number } {
  const [a, b, c] = dataRaw.split(/[\/.\-]/).map(Number);
  const ano = c < 100 ? 2000 + c : c;
  return formato === 'DMY' ? { ano, mes: b, dia: a } : { ano, mes: a, dia: b };
}

function paraISO(dataRaw: string, horaRaw: string, formato: FormatoData, offset: string): string {
  const { ano, mes, dia } = interpretarData(dataRaw, formato);
  const { h, m, s } = interpretarHora(horaRaw);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(ano, 4)}-${p(mes)}-${p(dia)}T${p(h)}:${p(m)}:${p(s)}${offset}`;
}

/**
 * Risco 1.1: "03/08" pode ser 3 de agosto (DMY) ou 8 de março (MDY) — depende
 * do idioma do celular de quem exportou, e o arquivo não diz qual. A única
 * prova é estatística: se alguma PRIMEIRA posição passar de 12, é DMY; se
 * alguma SEGUNDA posição passar de 12, é MDY. Se nada passar, é ambíguo — e aí
 * usamos a opção do usuário ou DMY (contexto pt-BR) com aviso.
 */
function detectarFormatoData(datas: Iterable<string>): FormatoData | 'ambiguo' {
  for (const d of datas) {
    const [a, b] = d.split(/[\/.\-]/).map(Number);
    if (a > 12) return 'DMY';
    if (b > 12) return 'MDY';
  }
  return 'ambiguo';
}

// ---------------------------------------------------------------- parser core

/** Consome um iterável de linhas (streaming — alimente com readline). */
export async function parseLinhas(
  linhas: AsyncIterable<string> | Iterable<string>,
  opcoes: OpcoesParse = {},
): Promise<ResultadoParse> {
  const brutas: Bruta[] = [];
  const avisos: string[] = [];
  let atual: Bruta | null = null;
  let linhasLidas = 0;
  let cabecalhoIgnorado = 0;

  for await (const linhaOriginal of linhas) {
    linhasLidas++;
    const linha = limpar(linhaOriginal);

    const mIos = linha.match(RE_IOS);
    const mAndroid = mIos ? null : linha.match(RE_ANDROID);
    const m = mIos ?? mAndroid;

    if (!m) {
      // Continuação da mensagem anterior (multilinha) — preserva a quebra.
      if (atual) atual.linhas.push(linhaOriginal.replace(RE_INVISIVEIS, ''));
      else if (linha.trim()) cabecalhoIgnorado++; // lixo antes da 1ª mensagem
      continue;
    }

    if (atual) brutas.push(atual);

    const resto = m[3];
    const mAutor = resto.match(RE_AUTOR);
    atual = {
      dataRaw: m[1],
      horaRaw: m[2].trim(),
      autorRaw: mAutor ? mAutor[1].trim() : '',
      linhas: [mAutor ? mAutor[2] : resto],
      plataforma: mIos ? 'ios' : 'android',
    };
  }
  if (atual) brutas.push(atual);

  if (cabecalhoIgnorado) {
    avisos.push(`${cabecalhoIgnorado} linha(s) antes da primeira mensagem foram ignoradas.`);
  }

  // ---- resolução do formato de data (agora que vimos o arquivo inteiro) ----
  const detectado = detectarFormatoData(brutas.map((b) => b.dataRaw));
  const usado: FormatoData = detectado !== 'ambiguo' ? detectado : (opcoes.formatoData ?? 'DMY');
  if (detectado === 'ambiguo') {
    avisos.push(
      opcoes.formatoData
        ? `Datas ambíguas (todos os valores ≤ 12); usando ${usado} conforme opção do usuário.`
        : `Datas ambíguas (todos os valores ≤ 12); assumindo ${usado} (pt-BR). CONFIRMAR com o usuário — risco de deslocar o histórico.`,
    );
  } else if (opcoes.formatoData && opcoes.formatoData !== detectado) {
    avisos.push(
      `Opção formatoData=${opcoes.formatoData} CONTRADIZ o arquivo (detectado ${detectado} por datas > 12). Usando ${detectado}.`,
    );
  }

  const offset = opcoes.offsetFuso ?? '-03:00';

  // ------------------------------- materialização -------------------------
  const mensagens: MensagemIngerida[] = [];
  const porTipo: Record<TipoMensagem, number> = { texto: 0, midia: 0, sistema: 0, audio_transcrito: 0 };
  let descartadas = 0;
  const contagem: Record<PlataformaExport, number> = { ios: 0, android: 0, desconhecida: 0 };

  for (const b of brutas) {
    contagem[b.plataforma]++;
    const conteudoCru = b.linhas.join('\n').trim();
    const conteudoLimpo = limpar(conteudoCru).trim();

    let tipo: TipoMensagem = 'texto';
    let conteudo = conteudoCru;
    let midia_arquivo: string | null = null;

    if (!b.autorRaw || RE_SISTEMA.test(conteudoLimpo)) {
      tipo = 'sistema';
    } else {
      const anexo =
        conteudoLimpo.match(RE_ANEXO_ANDROID) ?? conteudoLimpo.match(RE_ANEXO_IOS);
      if (anexo) {
        tipo = 'midia';
        midia_arquivo = anexo[1].trim();
        conteudo = '';
      } else if (MARCADORES_MIDIA.has(conteudoLimpo.toLowerCase())) {
        if (opcoes.descartarMidiaSemArquivo) {
          descartadas++;
          continue;
        }
        tipo = 'midia';
        conteudo = '';
      }
    }

    porTipo[tipo]++;
    mensagens.push({
      autor_raw: b.autorRaw || null,
      enviada_em: paraISO(b.dataRaw, b.horaRaw, usado, offset),
      conteudo,
      tipo,
      midia_arquivo,
      hash_mensagem: hashMensagem({
        dataRaw: b.dataRaw,
        horaRaw: b.horaRaw,
        autorRaw: b.autorRaw,
        conteudo: conteudoCru,
      }),
    });
  }

  const plataforma: PlataformaExport =
    contagem.ios > contagem.android ? 'ios' : contagem.android > 0 ? 'android' : 'desconhecida';

  return {
    mensagens,
    meta: {
      plataforma,
      formatoDataDetectado: detectado,
      formatoDataUsado: usado,
      linhasLidas,
      totalMensagens: mensagens.length,
      porTipo,
      descartadas,
      avisos,
    },
  };
}

/** Conveniência para testes e arquivos pequenos. Produção usa parseLinhas + readline. */
export async function parseTexto(texto: string, opcoes: OpcoesParse = {}): Promise<ResultadoParse> {
  return parseLinhas(texto.split(/\r?\n/), opcoes);
}

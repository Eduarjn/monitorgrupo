/**
 * Chaves de deduplicação e reconciliação entre as DUAS origens de mensagem.
 *
 * O projeto tem dois caminhos de ingestão que nunca vão produzir a mesma chave
 * naturalmente:
 *
 *   upload   — hash dos campos CRUS do .txt ('03/08/2026', '9:12:45 PM', autor
 *              como está na agenda de quem exportou)
 *   captura  — só tem epoch do servidor e o id da mensagem no WhatsApp
 *
 * Este módulo é a ponte, com três funções e uma regra por trás de cada uma.
 */

import { createHash } from 'node:crypto';

const sha = (partes: string[]) =>
  createHash('sha256').update(partes.join('\x1f')).digest('hex');

/**
 * Hash de dedup da mensagem capturada.
 *
 * ⚠️ CORREÇÃO 1 (repareamento). A primeira versão incluía o uuid da instância.
 * Isso quebrava feio: recriar a instância mudava o hash, o
 * `on conflict (grupo_id, hash_mensagem)` deixava de casar, e aí o OUTRO índice
 * único — `(grupo_id, wa_msg_id)` — levantava 23505 não tratado. Resultado: 500
 * na rota de webhook e a Evolution retentando a mesma mensagem em loop.
 *
 * Agora o hash depende só de coisas estáveis do WhatsApp: o grupo e o id da
 * mensagem. Repareamento não muda nada, e os dois índices concordam sempre.
 *
 * O prefixo 'wa' garante que nunca colida com um hash de upload: nenhum
 * `dataRaw` de arquivo começa com a string 'wa'.
 */
export const hashCaptura = (grupoJid: string, waMsgId: string): string =>
  sha(['wa', grupoJid, waMsgId]);

/**
 * Texto normalizado para reconciliação.
 *
 * O que entra: minúsculas, sem acento, espaços colapsados, sem os invisíveis
 * que o WhatsApp injeta (o mesmo problema que o parser já trata).
 * O que NÃO entra: hora e autor.
 *
 * O autor fica fora de propósito — o .txt traz o nome como está na agenda de
 * quem exportou ("Marcos Vendas", ou o telefone cru se não estiver na agenda) e
 * o webhook traz o pushName ("Marcos"). Os dois quase nunca batem, e exigir
 * igualdade destruiria a conciliação em vez de melhorá-la.
 */
export function normalizarTexto(bruto: string): string {
  return (bruto ?? '')
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hash do texto, ou null quando não há o que reconciliar.
 *
 * Mídia sem legenda (conteúdo vazio) fica FORA: no upload toda linha
 * "<Mídia oculta>" tem o mesmo texto, e casá-las colapsaria dezenas de fotos
 * numa só. Texto curtíssimo também fica fora — "ok" e "kkkk" casariam com
 * qualquer "ok" dentro da janela e sumiriam do histórico.
 */
export function hashTexto(conteudo: string): string | null {
  const t = normalizarTexto(conteudo);
  if (t.length < 8) return null;
  return sha(['txt', t.slice(0, 300)]);
}

/**
 * Tolerância da reconciliação, em segundos.
 *
 * ±90s cobre a deriva típica entre o relógio do celular (que carimba o .txt) e
 * o do servidor (que carimba o webhook), incluindo a virada de minuto. Mais que
 * isso começaria a engolir mensagem legítima repetida numa conversa real
 * ("confirmado" dito duas vezes em 3 minutos é normal e são duas mensagens).
 */
export const JANELA_RECONCILIACAO_SEG = 90;

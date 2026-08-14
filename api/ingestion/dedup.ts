/**
 * Deduplicação em DOIS níveis (decisão D3):
 *
 * 1. `hashArquivo` — evita reprocessar o MESMO arquivo (uploads.arquivo_hash).
 * 2. `hashMensagem` — o que torna a recoleta barata: o WhatsApp exporta a
 *    conversa inteira toda vez, então o segundo export contém todo o primeiro.
 *    O hash vai para `mensagens.hash_mensagem`, que tem índice único por grupo,
 *    e o insert em lote usa ON CONFLICT DO NOTHING — o Postgres descarta as
 *    repetidas na engine, sem SELECT de verificação.
 *
 * DECISÃO IMPORTANTE — o hash usa os campos CRUS (data/hora/autor como texto,
 * exatamente como saíram do arquivo), NÃO o timestamp interpretado. Motivo: a
 * interpretação DMY×MDY pode ser corrigida depois pelo usuário (risco 1.1); se
 * o hash dependesse dela, corrigir o formato mudaria todos os hashes e a
 * recoleta duplicaria o histórico inteiro. Com campos crus, o hash é estável
 * para sempre.
 */
import { createHash } from 'node:crypto';

export interface PartesMensagem {
  dataRaw: string;   // "03/08/2026" — como está no arquivo
  horaRaw: string;   // "09:15" ou "9:15:00 PM" — como está no arquivo
  autorRaw: string;  // "" para mensagem de sistema
  conteudo: string;
}

/** sha256 do conteúdo do arquivo de export (dedup de upload). */
export function hashArquivo(conteudo: string | Buffer): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

/**
 * sha256 das partes cruas da mensagem. O separador `\x1f` (unit separator)
 * impede colisão por concatenação ("a"+"bc" vs "ab"+"c").
 */
export function hashMensagem(p: PartesMensagem): string {
  return createHash('sha256')
    .update([p.dataRaw, p.horaRaw, p.autorRaw, p.conteudo].join('\x1f'))
    .digest('hex');
}

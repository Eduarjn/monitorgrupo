/**
 * Escolha do segmento do grupo.
 *
 * O que está em jogo aqui não é enfeite: o nicho decide QUAIS PERGUNTAS o painel
 * oferece. Um provedor quer saber quem está prestes a cancelar; um condomínio
 * quer saber se alguém expôs um morador. A mesma pergunta genérica ("o que ficou
 * pendente") não serve aos dois, e card genérico é card que ninguém clica.
 *
 * Só quem tem perfil de gestor pode trocar — mudar o nicho muda o painel inteiro
 * para todo mundo que acessa o grupo.
 */

import { useState } from 'react';
import { api, NICHOS, type Nicho } from '../lib/api.ts';
import { Aviso, Card, Titulo } from './ui.tsx';

export default function SeletorNicho({ grupo, nicho, podeGerir, aoMudar }: {
  grupo: number;
  nicho: Nicho | null;
  podeGerir: boolean;
  aoMudar: (n: Nicho | null) => void;
}) {
  const [salvando, setSalvando] = useState<Nicho | null | 'nenhum'>(null);
  const [erro, setErro] = useState('');

  const escolher = async (n: Nicho | null) => {
    if (n === nicho || salvando !== null) return;
    setSalvando(n ?? 'nenhum');
    setErro('');
    try {
      await api.definirNicho(grupo, n);
      aoMudar(n);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(null);
    }
  };

  const atual = NICHOS.find((x) => x.valor === nicho);

  // Sem permissão a escolha não é acionável — mostrar botões mortos seria pior
  // que não mostrar nada.
  if (!podeGerir) {
    return (
      <Card>
        <Titulo sub="Define quais perguntas o painel oferece.">Segmento do grupo</Titulo>
        <p className="text-sm">
          {atual
            ? <><b>{atual.rotulo}</b> <span className="text-muted-foreground">— {atual.exemplo}</span></>
            : <span className="text-muted-foreground">
                Nenhum segmento definido. Peça a um gestor para escolher e o painel passa a
                oferecer perguntas do seu negócio.
              </span>}
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <Titulo sub="Define quais perguntas o painel oferece na aba Consultas.">
        Segmento do grupo
      </Titulo>

      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {NICHOS.map((n) => {
          const ativo = n.valor === nicho;
          return (
            <button
              key={n.valor}
              onClick={() => escolher(n.valor)}
              disabled={salvando !== null}
              aria-pressed={ativo}
              className={`rounded-lg border px-3 py-2.5 text-left transition
                disabled:opacity-60
                ${ativo
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border bg-white/5 hover:border-primary/40 hover:bg-white/[0.07]'}`}
            >
              <span className="block font-display text-sm font-bold uppercase tracking-wide">
                {n.rotulo}
                {salvando === n.valor && <span className="ml-2 text-xs font-normal opacity-60">salvando…</span>}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {n.exemplo}
              </span>
            </button>
          );
        })}
      </div>

      {nicho && (
        <button
          onClick={() => escolher(null)}
          disabled={salvando !== null}
          className="mt-3 text-xs text-muted-foreground underline underline-offset-2
                     transition hover:text-foreground disabled:opacity-60"
        >
          Remover segmento (voltar aos cards genéricos)
        </button>
      )}
    </Card>
  );
}

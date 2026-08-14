import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, type Busca, type Resumo } from '../lib/api.ts';
import { Aviso, Botao, Card, Titulo } from '../componentes/ui.tsx';

export default function Analise({ grupo }: { grupo: number }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const [dia, setDia] = useState(hoje);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState<Busca | null>(null);
  const [indexacao, setIndexacao] = useState('');
  const [carregando, setCarregando] = useState<'' | 'resumo' | 'busca' | 'indexar'>('');
  const [erro, setErro] = useState('');

  const rodar = async (qual: 'resumo' | 'busca' | 'indexar', fn: () => Promise<void>) => {
    setErro('');
    setCarregando(qual);
    try {
      await fn();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setCarregando('');
    }
  };

  return (
    <div className="space-y-6">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      <Card>
        <Titulo sub="Escolha o dia e a IA resume os tópicos, decisões e pendências.">
          Resumo do dia
        </Titulo>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-secondary-foreground">Dia</span>
            <input type="date" value={dia} max={hoje} onChange={(e) => setDia(e.target.value)}
                   className="rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none
                              focus:border-primary/60" />
          </label>
          <Botao disabled={!!carregando}
                 onClick={() => rodar('resumo', async () => setResumo(await api.resumo(grupo, dia)))}>
            {carregando === 'resumo' ? 'Resumindo…' : 'Gerar resumo'}
          </Botao>
        </div>

        {resumo && (
          <div className="mt-4">
            {resumo.mensagens === 0 ? (
              <Aviso>Sem mensagens neste dia.</Aviso>
            ) : (
              <>
                <div className="mb-2 text-xs text-muted-foreground">
                  {resumo.mensagens} mensagens · {resumo.autores} participantes
                  {resumo.doCache && ' · resumo em cache (não gastou tokens)'}
                </div>
                <div className="whitespace-pre-wrap rounded-lg bg-secondary p-4 text-sm">
                  {resumo.resumo}
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      <Card>
        <Titulo sub="Pergunte em português. A resposta usa só os trechos recuperados e cita as fontes.">
          Busca no histórico
        </Titulo>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            rodar('busca', async () => setResposta(await api.buscar(grupo, pergunta)));
          }}
        >
          <input
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            placeholder="ex.: o que ficou decidido sobre a proposta?"
            className="flex-1 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none
                       placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
          <Botao type="submit" disabled={!!carregando || !pergunta.trim()}>
            {carregando === 'busca' ? 'Buscando…' : 'Perguntar'}
          </Botao>
        </form>

        {resposta && (
          <div className="mt-4 space-y-3">
            <div className="flex gap-2 rounded-lg bg-primary/10 p-4 text-sm">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="whitespace-pre-wrap">{resposta.resposta}</span>
            </div>

            {resposta.fontes.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Trechos usados na resposta
                </div>
                <div className="space-y-2">
                  {resposta.fontes.map((f) => (
                    <div key={f.bloco_id} className="rounded-lg border border-border p-3 text-xs">
                      <div className="mb-1 flex justify-between text-muted-foreground">
                        <span>{new Date(f.inicio_em).toLocaleString('pt-BR')}</span>
                        <span>similaridade {(f.similaridade * 100).toFixed(0)}%</span>
                      </div>
                      <div className="whitespace-pre-wrap">{f.trecho}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-xs text-muted-foreground">
            A busca só encontra o que já foi indexado. Depois de enviar um export novo, reindexe.
          </p>
          <div className="flex items-center gap-3">
            <button
              disabled={!!carregando}
              onClick={() =>
                rodar('indexar', async () => {
                  const r = await api.indexar(grupo);
                  setIndexacao(
                    r.blocos + ' blocos indexados' +
                    (r.usd ? ' · custo estimado US$ ' + r.usd.toFixed(4) : ''),
                  );
                })
              }
              className="rounded-lg border border-border px-3 py-1.5 font-display text-xs font-semibold
                         uppercase tracking-wider text-muted-foreground transition
                         hover:border-primary/50 hover:text-primary"
            >
              {carregando === 'indexar' ? 'Indexando…' : 'Reindexar histórico'}
            </button>
            {indexacao && <span className="text-xs text-muted-foreground">{indexacao}</span>}
          </div>
        </div>
      </Card>
    </div>
  );
}

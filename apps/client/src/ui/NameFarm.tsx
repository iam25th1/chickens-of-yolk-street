// Name your farm: after the first sign-in (and for farms named before farm naming), and from
// Settings once an in-game week. The farm's sign shows the name as it is typed; a goofy suggestion
// is filled in, SHUFFLE draws another, CONFIRM sends it (the server checks the rules again). Closing
// without confirming keeps the generated name. Every player sees the name, so it must not be the
// player's email name: the screen says so at once, and the server refuses it by hash.
import { useEffect, useRef, useState } from 'react';
import { FARM_NAME_MAX, FARM_NAME_PROBLEM_TEXT, checkFarmName, suggestFarmName, type FarmState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { events } from '../state/game';
import { myEmailName } from '../state/emailName';
import { Modal } from './Modal';
import { SheetSprite } from './SheetSprite';

export function NameFarm({ farm, mode, send, onClose }: { farm: FarmState; mode: 'first' | 'rename'; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio } = useServices();
  const v = useViewport();
  const [name, setName] = useState(mode === 'first' ? farm.name : suggestFarmName());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sign = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const waitDay = mode === 'rename' ? farm.renameFromDay : null;
  const local = checkFarmName(name, myEmailName());
  const problem = !local.ok ? FARM_NAME_PROBLEM_TEXT[local.problem] : refusal;

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  // the server's word on a refused name, shown here instead of a toast
  useEffect(
    () =>
      events.on((e) => {
        if (e.kind === 'refused' && e.code.startsWith('name_')) setRefusal(e.message);
      }),
    [],
  );

  const shuffle = () => {
    uiSound(audio, 'click');
    setName(suggestFarmName());
    setRefusal(null);
    if (sign.current) motion.enter(sign.current);
  };
  const confirm = async () => {
    if (!local.ok || busy || waitDay !== null) return;
    uiSound(audio, 'click');
    setBusy(true);
    setRefusal(null);
    const ok = await send({ t: 'setFarmName', name: local.name });
    setBusy(false);
    if (ok) {
      audio.play('18-stamp');
      onClose();
    }
  };
  const close = () => {
    // closing the first naming keeps the generated name, and the question is not asked again
    if (mode === 'first') void send({ t: 'keepFarmName' });
    onClose();
  };

  return (
    <Modal title={mode === 'first' ? 'NAME YOUR FARM' : 'RENAME YOUR FARM'} onClose={close} w={400} h={300} dismiss={false}>
      <div className="col" style={{ gap: 8, alignItems: 'center' }} data-ui="name-farm">
        <div ref={sign} className="col" style={{ alignItems: 'center', gap: 2 }}>
          <SheetSprite id="17-sign-farm" row="sway" play="loop" size={v.p} box={{ w: 64, h: 48 }} />
          <span className="display" data-ui="name-preview" style={{ color: '#7f2215', textAlign: 'center', minHeight: 16, maxWidth: 360, wordBreak: 'break-word' }}>
            {(local.ok ? local.name : name.trim()).toUpperCase() || ' '}
          </span>
        </div>
        <span style={{ lineHeight: '10px', textAlign: 'center' }}>EVERY FARMER ON YOLK STREET SEES THIS NAME. KEEP IT FUN; NEVER YOUR EMAIL OR YOUR REAL NAME.</span>
        <input
          ref={field}
          className="field"
          data-ui="name-field"
          aria-label="Farm name"
          value={name}
          maxLength={FARM_NAME_MAX}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setRefusal(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void confirm();
          }}
          style={{ width: '100%', maxWidth: 300, textAlign: 'center' }}
        />
        <span data-ui="name-problem" style={{ color: '#b8321f', minHeight: 9, lineHeight: '9px', textAlign: 'center' }}>
          {waitDay !== null ? `YOU CAN RENAME YOUR FARM AGAIN ON DAY ${waitDay}.` : (problem ?? '')}
        </span>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="btn" data-ui="name-shuffle" onClick={shuffle}>
            SHUFFLE
          </button>
          <button className="btn red" data-ui="name-confirm" disabled={!local.ok || busy || waitDay !== null} onClick={() => void confirm()}>
            {busy ? 'NAMING' : 'CONFIRM'}
          </button>
          {mode === 'first' && (
            <button className="btn" data-ui="name-keep" onClick={close}>
              KEEP {farm.name.toUpperCase()}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

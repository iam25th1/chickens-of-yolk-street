// Saving a guest farm: the card that offers signing in, at the natural moments. A Feather ticket won
// (it is saved on the farm; minting it needs a wallet), about ten minutes of play (once a session),
// MINT on the mint page, and SAVE THIS FARM in Settings and on the profile. It never blocks play:
// LATER, Escape or a tap outside closes it. Signing in carries the whole farm into the account.
import { useEffect, useRef } from 'react';
import { GUEST_MINT_TEXT } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import type { SaveReason } from '../state/ui';
import { Modal } from './Modal';

const CARRY = 'YOUR COINS, HENS, MACHINES, LAND, BADGES, TICKETS AND RECORDS COME WITH IT.';

const COPY: Record<SaveReason, { title: string; lines: string[] }> = {
  ticket: { title: 'YOUR TICKET IS SAVED', lines: ['YOU WON A FEATHER TICKET. IT IS SAVED ON THIS FARM.', GUEST_MINT_TEXT.toUpperCase()] },
  mint: { title: 'SIGN IN TO MINT', lines: ['YOUR TICKETS ARE SAVED ON THIS FARM.', GUEST_MINT_TEXT.toUpperCase()] },
  nudge: { title: 'SAVE THIS FARM?', lines: ['YOU HAVE BEEN FARMING A WHILE. SIGN IN WITH YOUR EMAIL TO KEEP THIS FARM AND PLAY IT ON ANY DEVICE.', CARRY] },
  settings: { title: 'SAVE THIS FARM', lines: ['SIGN IN WITH YOUR EMAIL TO KEEP THIS FARM AND PLAY IT ON ANY DEVICE.', CARRY] },
  profile: { title: 'SAVE THIS FARM', lines: ['SIGN IN WITH YOUR EMAIL TO KEEP THIS FARM AND PLAY IT ON ANY DEVICE.', CARRY] },
};

export function SaveFarm({ reason, onSignIn, onClose }: { reason: SaveReason; onSignIn: () => void; onClose: () => void }) {
  const { audio } = useServices();
  const ticket = useRef<HTMLSpanElement>(null);
  const copy = COPY[reason];
  // the ticket (or the farm's key) bobs gently while the card is up
  useEffect(() => {
    const el = ticket.current;
    if (!el) return;
    const a = motion.bob(el);
    return () => {
      a.pause();
    };
  }, []);
  return (
    <Modal title={copy.title} onClose={onClose} w={320} h={200}>
      <div className="col" style={{ gap: 6 }} data-ui="save-farm" data-reason={reason}>
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <span ref={ticket} className="save-mark" aria-hidden="true">
            {reason === 'ticket' || reason === 'mint' ? 'TICKET' : 'SAVE'}
          </span>
          <span className="col" style={{ gap: 4, minWidth: 0 }}>
            {copy.lines.map((l) => (
              <span key={l} style={{ lineHeight: '10px' }}>
                {l}
              </span>
            ))}
          </span>
        </div>
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <button
            className="btn"
            data-ui="save-later"
            onClick={() => {
              uiSound(audio, 'back');
              onClose();
            }}
          >
            LATER
          </button>
          <button
            className="btn red"
            data-ui="save-sign-in"
            onClick={() => {
              uiSound(audio, 'click');
              onSignIn();
            }}
          >
            SIGN IN
          </button>
        </div>
      </div>
    </Modal>
  );
}

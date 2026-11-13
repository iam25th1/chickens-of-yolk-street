// A gentle prompt when the game was updated while this page was open: the server came back on a new
// build (the socket hears it on reconnecting). RELOAD loads the new version; LATER hides the prompt.
import { uiSound, useServices } from '../app/services';
import { game } from '../state/game';
import { useStore } from '../state/store';

export function UpdatePrompt() {
  const { audio } = useServices();
  const newVersion = useStore(game, (s) => s.newVersion ?? false);
  if (!newVersion) return null;
  return (
    <div className="panel" role="status" data-ui="update-prompt" style={{ left: 170, top: 30, width: 300, padding: 6, pointerEvents: 'auto' }}>
      <div className="row spread" style={{ gap: 6, alignItems: 'center' }}>
        <span style={{ lineHeight: '9px' }}>A NEW VERSION OF THE GAME IS READY.</span>
        <span className="row" style={{ gap: 4, flex: 'none' }}>
          <button
            className="btn red"
            data-ui="update-reload"
            onClick={() => {
              uiSound(audio, 'click');
              location.reload();
            }}
          >
            RELOAD
          </button>
          <button
            className="btn"
            onClick={() => {
              uiSound(audio, 'click');
              game.set({ newVersion: false });
            }}
          >
            LATER
          </button>
        </span>
      </div>
    </div>
  );
}

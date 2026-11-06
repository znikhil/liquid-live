// After the call: everything that was said, to read back (handy after tutoring).

import { Phone, RotateCcw } from "lucide-react";
import { AVATARS } from "../avatar/catalog";
import type { TranscriptTurn } from "../call/CallClient";
import type { CallSetup } from "./CallScreen";

type Props = { setup: CallSetup; transcript: TranscriptTurn[]; onAgain(): void; onHome(): void };

export function Summary({ setup, transcript, onAgain, onHome }: Props) {
  const name = AVATARS[setup.avatarId].name;
  return (
    <main className="summary">
      <h1>Call with {name}</h1>
      <p className="muted">{setup.mode.title}</p>
      {transcript.length ? (
        <ol className="transcript">
          {transcript.map((turn, i) => (
            <li key={i}>
              {turn.you && (
                <p className="you">
                  <b>You</b> {turn.you}
                </p>
              )}
              {turn.agent && (
                <p>
                  <b>{name}</b> {turn.agent}
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Nothing was said in this call.</p>
      )}
      <div className="summary-actions">
        <button className="btn primary" onClick={onAgain}>
          <RotateCcw size={16} /> Call again
        </button>
        <button className="btn" onClick={onHome}>
          <Phone size={16} /> New call
        </button>
      </div>
    </main>
  );
}

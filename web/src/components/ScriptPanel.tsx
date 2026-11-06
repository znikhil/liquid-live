// Rehearse a written dialogue: edit the script, choose who says your lines, run it.

import { useState } from "react";
import { Play, Square } from "lucide-react";
import type { Voice } from "../../../shared/protocol";
import type { CallClient } from "../call/CallClient";
import { parseScript, SAMPLE_SCRIPT } from "../call/script";
import type { ScriptRunner } from "../call/ScriptRunner";
import { prefs, type ScriptVoice } from "../prefs";
import { useStore } from "../store";

type Props = { call: CallClient; script: ScriptRunner; voice: Voice };

export function ScriptPanel({ call, script, voice }: Props) {
  const { at, total } = useStore(script);
  const { phase } = useStore(call);
  const [text, setText] = useState(() => prefs.script.get() || SAMPLE_SCRIPT);
  const [who, setWho] = useState<ScriptVoice>(prefs.scriptVoice.get);
  const running = at >= 0;
  const turns = parseScript(text).length;

  function chooseWho(next: ScriptVoice) {
    setWho(next);
    prefs.scriptVoice.set(next);
  }

  function run() {
    prefs.script.set(text);
    void script.play(text, who, voice);
  }

  return (
    <div className="panel script-panel">
      {running ? (
        <div className="progress">
          <span style={{ width: `${((at + 1) / Math.max(1, total)) * 100}%` }} />
        </div>
      ) : (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} spellCheck={false} placeholder={"Agent: Hi! How can I help?\nYou: I'd like a coffee, please."} />
      )}
      <div className="script-bar">
        <div className="seg" role="radiogroup" aria-label="Who says your lines">
          <button className={who === "ai" ? "on" : ""} onClick={() => chooseWho("ai")} disabled={running}>
            AI voice
          </button>
          <button className={who === "me" ? "on" : ""} onClick={() => chooseWho("me")} disabled={running}>
            Me
          </button>
        </div>
        <span className="muted">
          {running ? `Turn ${at + 1} of ${total}` : who === "me" ? "You say your lines into the mic" : "Your lines are read in the other voice"}
        </span>
        {running ? (
          <button className="btn" onClick={() => script.stop()}>
            <Square size={14} /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={run} disabled={!turns || phase === "connecting" || phase === "ended"}>
            <Play size={14} /> Run script
          </button>
        )}
      </div>
    </div>
  );
}

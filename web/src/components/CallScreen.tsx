// The call, laid out like a video call: the assistant's tile fills the stage
// (a photo-real head) with a status chip, its name, live captions
// and your draggable camera; the control bar sits below.

import { useEffect, useRef, useState } from "react";
import { AudioLines, LoaderCircle } from "lucide-react";
import type { ModeInfo, SpeechEngine } from "../../../shared/protocol";
import { AVATARS, type Avatar, type AvatarId } from "../avatar/catalog";
import { CallClient, type CallState, type TranscriptTurn } from "../call/CallClient";
import { ScriptRunner, type ScriptState } from "../call/ScriptRunner";
import { Store, useStore } from "../store";
import { Captions } from "./Captions";
import { ControlBar } from "./ControlBar";
import { ScriptPanel } from "./ScriptPanel";
import { SelfView } from "./SelfView";
import { TextBox } from "./TextBox";

export type CallSetup = { mode: ModeInfo; avatarId: AvatarId; emotions: boolean; camera: boolean; shareCamera: boolean; search: boolean; speech: SpeechEngine };

type Session = { call: CallClient; script: ScriptRunner };
type Panel = "none" | "type" | "script";

/** Stand-ins while the call is being set up, so hooks always have a store to read. */
const CONNECTING = new Store<CallState>({ phase: "connecting", you: "", agent: "", error: "", muted: false, camera: null, transcript: [] });
const NO_SCRIPT = new Store<ScriptState>({ at: -1, total: 0, cue: "" });

const PHASE_TEXT: Record<CallState["phase"], string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Talk any time to interrupt",
  ended: "Call ended",
};

export function CallScreen({ setup, onEnd }: { setup: CallSetup; onEnd(transcript: TranscriptTurn[]): void }) {
  const profile = AVATARS[setup.avatarId];
  const node = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [face, setFace] = useState<"loading" | "ready" | "failed">("loading");
  const [panel, setPanel] = useState<Panel>("none");
  const state = useStore(session?.call ?? CONNECTING);
  const script = useStore(session?.script ?? NO_SCRIPT);

  // The head loads first (lazily: three.js is big), so the call can play its speech through it.
  useEffect(() => {
    let alive = true;
    let avatar: Avatar | null = null;
    let call: CallClient | null = null;
    (async () => {
      if (node.current) {
        try {
          const { LamHead } = await import("../avatar/lamHead");
          if (!alive) return;
          avatar = new LamHead(node.current, profile.url, { emotions: setup.emotions });
          avatar.ready.then(
            () => alive && setFace("ready"),
            () => alive && setFace("failed"),
          );
        } catch {
          setFace("failed");
        }
      }
      if (!alive) return;
      call = new CallClient({ mode: setup.mode.id, profile, emotions: setup.emotions, camera: setup.camera, shareCamera: setup.shareCamera, search: setup.search, speech: setup.speech, avatar });
      setSession({ call, script: new ScriptRunner(call) });
      call.start();
    })();
    return () => {
      alive = false;
      call?.end();
      avatar?.dispose();
    };
  }, []);

  function hangUp() {
    session?.script.stop();
    session?.call.end();
    onEnd(session?.call.state.transcript ?? []);
  }

  const status = script.cue
    ? "Your turn: say your line"
    : script.at >= 0
      ? `Script ${script.at + 1}/${script.total} · ${PHASE_TEXT[state.phase]}`
      : state.muted && state.phase !== "ended"
        ? "You're muted"
        : PHASE_TEXT[state.phase];

  return (
    <div className="call">
      <header className="call-head">
        <span className="pill">{setup.speech === "omni" ? "LFM3 Omni 2B · on this computer" : "Runs on this computer"}</span>
      </header>

      <div className={`tile phase-${state.phase}`}>
        <div className="tile-status">
          {state.phase === "connecting" && <LoaderCircle size={13} className="spin" />}
          {status}
        </div>

        <div className="avatar-frame">
          <div ref={node} className="avatar-view" />
          {face !== "ready" && (
            <div className="avatar-note">
              {face === "loading" ? (
                <>
                  <LoaderCircle size={14} className="spin" /> Loading {profile.name}…
                </>
              ) : (
                "The face couldn't load, so the voice plays without it."
              )}
            </div>
          )}
        </div>

        <Captions you={state.you} agent={state.agent} cue={script.cue} name={profile.name} />
        {state.error && <div className="call-error">{state.error}</div>}

        <div className="tile-name">
          {state.phase === "speaking" && <AudioLines size={14} />}
          {profile.name}
        </div>
        {state.camera && <SelfView stream={state.camera} />}

        {state.phase === "ended" && (
          <div className="ended">
            <p>The call ended.</p>
            <button className="btn primary" onClick={hangUp}>
              Done
            </button>
          </div>
        )}
      </div>

      {session && panel === "script" && <ScriptPanel call={session.call} script={session.script} voice={profile.voice} />}
      {session && panel === "type" && state.phase !== "ended" && <TextBox onSend={(text) => session.call.sendText(text)} />}

      <ControlBar
        label={setup.speech === "omni" ? setup.mode.title : `${setup.mode.title} · Woof ${setup.speech === "juno" ? "Juno" : "Mira"}`}
        state={state}
        panel={panel}
        onMute={() => session?.call.setMuted(!state.muted)}
        onCamera={() => session?.call.setCamera(!state.camera)}
        onPanel={(p) => setPanel(panel === p ? "none" : p)}
        onHangUp={hangUp}
      />
    </div>
  );
}

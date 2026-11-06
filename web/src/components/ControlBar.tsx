// The call's control bar: time and what the call is on the left, buttons in
// the middle, a red pill to hang up.

import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Mic, MicOff, PhoneOff, ScrollText, Video, VideoOff } from "lucide-react";
import type { CallState } from "../call/CallClient";

type Props = {
  label: string;
  state: CallState;
  panel: "none" | "type" | "script";
  onMute(): void;
  onCamera(): void;
  onPanel(panel: "type" | "script"): void;
  onHangUp(): void;
};

const clockText = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function ControlBar({ label, state, panel, onMute, onCamera, onPanel, onHangUp }: Props) {
  const [clock, setClock] = useState(clockText);
  useEffect(() => {
    const timer = setInterval(() => setClock(clockText()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const live = state.phase !== "connecting" && state.phase !== "ended";

  return (
    <footer className="controls">
      <div className="controls-info">
        {clock} <span>|</span> {label}
      </div>
      <div className="controls-buttons">
        <RoundButton label={state.muted ? "Unmute" : "Mute"} tone={state.muted ? "off" : undefined} onClick={onMute} disabled={!live}>
          {state.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </RoundButton>
        <RoundButton label={state.camera ? "Turn camera off" : "Turn camera on"} tone={state.camera ? "on" : "off"} onClick={onCamera} disabled={!live}>
          {state.camera ? <Video size={20} /> : <VideoOff size={20} />}
        </RoundButton>
        <RoundButton label="Type a message" tone={panel === "type" ? "on" : undefined} onClick={() => onPanel("type")} disabled={!live}>
          <Keyboard size={20} />
        </RoundButton>
        <RoundButton label="Rehearse a script" tone={panel === "script" ? "on" : undefined} onClick={() => onPanel("script")}>
          <ScrollText size={20} />
        </RoundButton>
        <button className="ctl hang-up" onClick={onHangUp} aria-label="End call" title="End call">
          <PhoneOff size={20} />
        </button>
      </div>
      <div className="controls-spacer" />
    </footer>
  );
}

function RoundButton({ label, tone, children, ...rest }: { label: string; tone?: "on" | "off"; children: ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <button className={`ctl${tone ? ` ${tone}` : ""}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

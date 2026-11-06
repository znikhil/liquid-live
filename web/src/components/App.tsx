// Three screens: the lobby (pick what to do and who to talk to), the call,
// and the summary with the call's transcript.

import { useEffect, useState } from "react";
import type { Status } from "../../../shared/protocol";
import { fetchStatus } from "../api";
import type { TranscriptTurn } from "../call/CallClient";
import { CallScreen, type CallSetup } from "./CallScreen";
import { Lobby } from "./Lobby";
import { Summary } from "./Summary";

type Screen = { name: "lobby" } | { name: "call"; setup: CallSetup; id: number } | { name: "summary"; setup: CallSetup; transcript: TranscriptTurn[] };

const STATUS_EVERY_MS = 4000;

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "lobby" });
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);

  // The lobby shows which models are up, so it keeps checking.
  useEffect(() => {
    if (screen.name !== "lobby") return;
    let alive = true;
    const check = () =>
      fetchStatus()
        .then((s) => alive && (setStatus(s), setOffline(false)))
        .catch(() => alive && setOffline(true));
    check();
    const timer = setInterval(check, STATUS_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [screen.name]);

  switch (screen.name) {
    case "lobby":
      return <Lobby status={status} offline={offline} onStart={(setup) => setScreen({ name: "call", setup, id: Date.now() })} />;
    case "call":
      return (
        <CallScreen
          // A new call gets a fresh screen, even with the same setup.
          key={screen.id}
          setup={screen.setup}
          onEnd={(transcript) => setScreen({ name: "summary", setup: screen.setup, transcript })}
        />
      );
    case "summary":
      return (
        <Summary
          setup={screen.setup}
          transcript={screen.transcript}
          onAgain={() => setScreen({ name: "call", setup: screen.setup, id: Date.now() })}
          onHome={() => setScreen({ name: "lobby" })}
        />
      );
  }
}

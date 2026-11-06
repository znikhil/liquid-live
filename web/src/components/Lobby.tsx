// Pick a use case and who to talk to, then start the call.

import { useState, type ReactNode } from "react";
import { GraduationCap, Phone, Sparkles } from "lucide-react";
import type { ModeInfo, SpeechEngine, Status } from "../../../shared/protocol";
import { AVATAR_IDS, AVATARS, type AvatarId } from "../avatar/catalog";
import { prefs } from "../prefs";
import type { CallSetup } from "./CallScreen";

const SPEECH_LABELS: Record<SpeechEngine, string> = { omni: "Omni", juno: "Woof · Juno", mira: "Woof · Mira" };

const MODE_ICONS: Record<string, ReactNode> = {
  assistant: <Sparkles size={20} />,
  tutor: <GraduationCap size={20} />,
};

type Props = { status: Status | null; offline: boolean; onStart(setup: CallSetup): void };

export function Lobby({ status, offline, onStart }: Props) {
  const [modeId, setModeId] = useState(prefs.mode.get);
  const [avatarId, setAvatarId] = useState<AvatarId>(prefs.avatar.get);
  const [emotions, setEmotions] = useState(prefs.emotions.get);
  const [camera, setCamera] = useState(prefs.camera.get);
  const [search, setSearch] = useState(prefs.search.get);
  const [speech, setSpeech] = useState<SpeechEngine>(prefs.speech.get);

  const modes = status?.modes ?? [];
  const mode = modes.find((m) => m.id === modeId) ?? modes[0];
  // A call needs something to answer: Omni, or (with Omni off) the brain.
  const usable = (m: ModeInfo) => !!status && (status.omni || status.brain) && (!m.needsBrain || status.brain);

  function chooseMode(id: string) {
    setModeId(id);
    prefs.mode.set(id);
  }

  function chooseAvatar(id: AvatarId) {
    setAvatarId(id);
    prefs.avatar.set(id);
  }

  function start() {
    if (!mode || !usable(mode)) return;
    prefs.emotions.set(emotions);
    prefs.camera.set(camera);
    prefs.search.set(search);
    prefs.speech.set(speech);
    // Without Omni there is no Omni voice, and the camera is a self-view the AI never sees.
    const omni = !!status?.omni;
    const voice = !omni && speech === "omni" ? "juno" : speech;
    onStart({ mode, avatarId, emotions, camera, shareCamera: omni, search: search && !!status?.news, speech: status?.woof ? voice : "omni" });
  }

  return (
    <main className="lobby">
      <header className="lobby-head">
        <h1>Samvad AI</h1>
        <p>Face-to-face conversations with a private AI that runs on this computer.</p>
        <ModelStatus status={status} offline={offline} />
      </header>

      <section>
        <h2>What do you want to do?</h2>
        <div className="mode-grid">
          {modes.map((m) => (
            <button key={m.id} className={`mode-card${m.id === mode?.id ? " selected" : ""}`} onClick={() => chooseMode(m.id)} disabled={!usable(m)}>
              <span className="mode-icon">{MODE_ICONS[m.id] ?? <Sparkles size={20} />}</span>
              <b>{m.title}</b>
              <span>{m.description}</span>
              {m.needsBrain && status && !status.brain && <em>Needs LFM3 1.7B</em>}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Who do you want to talk to?</h2>
        <div className="chips" role="radiogroup" aria-label="Avatar">
          {AVATAR_IDS.map((id) => (
            <button key={id} role="radio" aria-checked={id === avatarId} className={`chip${id === avatarId ? " on" : ""}`} onClick={() => chooseAvatar(id)}>
              {AVATARS[id].label}
            </button>
          ))}
        </div>
        {status?.woof && (
          <div className="chips" role="radiogroup" aria-label="Voice">
            <span className="chips-label">Voice</span>
            {(Object.keys(SPEECH_LABELS) as SpeechEngine[]).filter((id) => id !== "omni" || status.omni).map((id) => (
              <button key={id} role="radio" aria-checked={id === (status.omni || speech !== "omni" ? speech : "juno")} className={`chip${id === (status.omni || speech !== "omni" ? speech : "juno") ? " on" : ""}`} onClick={() => setSpeech(id)}>
                {SPEECH_LABELS[id]}
              </button>
            ))}
          </div>
        )}
        <div className="toggles">
          <label title={status?.omni ? "The AI can see your camera when you ask about it." : "Only you see your camera: no picture is sent to the AI."}>
            <input type="checkbox" checked={camera} onChange={(e) => setCamera(e.target.checked)} /> Start with my camera on{status && !status.omni ? " (only you see it)" : ""}
          </label>
          {status?.news && mode?.id === "assistant" && (
            <label title="Questions about news, scores, weather or prices are searched on the web with Tavily. Only those questions leave this computer.">
              <input type="checkbox" checked={search} onChange={(e) => setSearch(e.target.checked)} /> Live search for news
            </label>
          )}
          <label title="A light smile, frown or raised brows that follow the feeling of each sentence.">
            <input type="checkbox" checked={emotions} onChange={(e) => setEmotions(e.target.checked)} /> Facial expressions
          </label>
        </div>
        {status && !status.setupNeeded && !status.face && <p className="note">The face model (LAM A2E) isn't downloaded, so the head won't move its lips.</p>}
      </section>

      <button className="start" onClick={start} disabled={!mode || !usable(mode)}>
        <Phone size={18} /> Start call{mode ? ` · ${mode.title}` : ""}
      </button>
    </main>
  );
}

function ModelStatus({ status, offline }: { status: Status | null; offline: boolean }) {
  if (offline) return <p className="status-row bad">Can't reach the Samvad AI server.</p>;
  if (!status) return <p className="status-row">Checking the models…</p>;
  if (status.setupNeeded)
    return (
      <p className="status-row bad">
        The models aren't downloaded yet. In the project folder, run <code>npm run setup</code>; calls work as soon as it finishes.
      </p>
    );
  const items = [
    ...(status.omni ? [{ label: status.omniLoaded ? "LFM3 Omni 2B" : "LFM3 Omni 2B · on demand", up: true, note: "loaded only for the Omni voice or the camera" }] : []),
    { label: status.brainName, up: status.brain, note: "the brain: writes Aria's answers" },
    { label: "LAM A2E", up: status.face, note: "lip sync" },
    { label: "d1-2B", up: status.router, note: "decides where each request goes" },
    ...(status.news ? [{ label: "Live news", up: true, note: "Tavily web search for news questions" }] : []),
  ];
  return (
    <ul className="status-row">
      {items.map((i) => (
        <li key={i.label} className={i.up ? "up" : "down"} title={i.note}>
          {i.label}
        </li>
      ))}
    </ul>
  );
}

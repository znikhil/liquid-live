import { useState } from "react";
import { Send } from "lucide-react";

/** Type a message instead of saying it. */
export function TextBox({ onSend }: { onSend(text: string): void }) {
  const [text, setText] = useState("");
  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };
  return (
    <div className="panel text-box">
      <input autoFocus value={text} placeholder="Type a message" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <button className="round-btn" onClick={send} aria-label="Send">
        <Send size={16} />
      </button>
    </div>
  );
}

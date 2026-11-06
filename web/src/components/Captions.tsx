/** Live captions under the face; during a script, the line you're to say. */
export function Captions({ you, agent, cue, name }: { you: string; agent: string; cue: string; name: string }) {
  if (!cue && !you && !agent) return null;
  return (
    <div className="captions" aria-live="polite">
      {cue ? (
        <p className="cue">
          <b>Your line</b> {cue}
        </p>
      ) : (
        <>
          {you && (
            <p>
              <b>You</b> {you}
            </p>
          )}
          {agent && (
            <p>
              <b>{name}</b> {agent}
            </p>
          )}
        </>
      )}
    </div>
  );
}

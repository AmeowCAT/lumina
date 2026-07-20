import { useEffect, useRef } from "react";

export function useKeyboardShortcuts(handlers: {
  onGenerate: () => void;
  onRandomSeed: () => void;
  onEscape: () => void;
  escapeActive: boolean;
}) {
  const genRef = useRef(handlers.onGenerate);
  const seedRef = useRef(handlers.onRandomSeed);
  const escRef = useRef(handlers.onEscape);
  genRef.current = handlers.onGenerate;
  seedRef.current = handlers.onRandomSeed;
  escRef.current = handlers.onEscape;
  escRef.current = handlers.onEscape;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        genRef.current();
      }
      if (e.ctrlKey && e.key === "r" && !e.shiftKey) {
        e.preventDefault();
        seedRef.current();
      }
      if (e.key === "Escape" && handlers.escapeActive) escRef.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handlers.escapeActive]);
}

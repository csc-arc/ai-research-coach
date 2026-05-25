/**
 * Shared passcode + reviewer gate for the two PI apps (`/pi` and
 * `/pi/drafts`). Wraps a ThemeProvider + CssBaseline + the same passcode
 * UX `PIApp.tsx` had. The wrapped child receives the resolved reviewer name
 * and a `switchReviewer` callback so each app's app-bar can host its own
 * reviewer chip.
 */

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  ThemeProvider,
  Typography,
  createTheme,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  PiApiError,
  clearPiPasscode,
  fetchIndex,
  getPiPasscode,
  getReviewerName,
  setPiPasscode,
  setReviewerName,
} from "./piApi";

export const piTheme = createTheme({
  palette: {
    primary: { main: "#1976d2" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          padding: 0,
          height: "100vh",
          overflow: "hidden",
        },
        "#root": {
          height: "100vh",
          display: "flex",
          flexDirection: "column",
        },
      },
    },
  },
});

function PassCodeGate({ onUnlock }: { onUnlock: () => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setPiPasscode(draft);
    try {
      await fetchIndex();
      onUnlock();
    } catch (err) {
      clearPiPasscode();
      if (err instanceof PiApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to validate passcode");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Box sx={{ width: 360, p: 3 }}>
        <Typography variant="h6" gutterBottom>
          AI Research Coach — PI Dashboard
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Enter the shared PI passcode to browse coaching sessions.
        </Typography>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Passcode"
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 14,
              border: "1px solid #ccc",
              borderRadius: 4,
              outline: "none",
            }}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
          <Box sx={{ mt: 2, display: "flex", justifyContent: "flex-end" }}>
            <Button
              type="submit"
              variant="contained"
              disabled={!draft || submitting}
            >
              {submitting ? <CircularProgress size={18} /> : "Enter"}
            </Button>
          </Box>
        </form>
      </Box>
    </Box>
  );
}

export interface PiAppShellRenderArgs {
  reviewer: string | null;
  switchReviewer: () => void;
  onLogout: () => void;
}

interface PiAppShellProps {
  children: (args: PiAppShellRenderArgs) => React.ReactNode;
}

export default function PiAppShell({ children }: PiAppShellProps) {
  const [unlocked, setUnlocked] = useState<boolean>(() => !!getPiPasscode());
  const [reviewer, setReviewerState] = useState<string | null>(() => getReviewerName());

  const handleSwitchReviewer = useCallback(() => {
    const next = window.prompt(
      "Reviewer name (shown on feedback you leave):",
      reviewer ?? "",
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setReviewerName(trimmed);
    setReviewerState(trimmed);
  }, [reviewer]);

  // Prompt for reviewer on first unlock if missing (matches the legacy
  // PIApp behavior).
  useEffect(() => {
    if (unlocked && !reviewer) {
      const next = window.prompt(
        "Welcome! What name should we attribute your feedback to?",
        "",
      );
      const trimmed = (next ?? "").trim();
      if (trimmed) {
        setReviewerName(trimmed);
        setReviewerState(trimmed);
      }
    }
  }, [unlocked, reviewer]);

  const handleLogout = useCallback(() => {
    clearPiPasscode();
    setUnlocked(false);
  }, []);

  if (!unlocked) {
    return (
      <ThemeProvider theme={piTheme}>
        <CssBaseline />
        <PassCodeGate onUnlock={() => setUnlocked(true)} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={piTheme}>
      <CssBaseline />
      {children({
        reviewer,
        switchReviewer: handleSwitchReviewer,
        onLogout: handleLogout,
      })}
    </ThemeProvider>
  );
}

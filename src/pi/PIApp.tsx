import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  IconButton,
  Stack,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";
import RefreshIcon from "@mui/icons-material/Refresh";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IndexTree,
  PiApiError,
  SessionBundle,
  clearPiPasscode,
  fetchIndex,
  fetchSessionBundle,
  getPiPasscode,
  setPiPasscode,
  getReviewerName,
  setReviewerName,
} from "./piApi";
import PINavigator from "./PINavigator";
import SessionViewer from "./SessionViewer";
import DraftsAppBarWidget from "./DraftsAppBarWidget";
import logoIcon from "/logo-white.svg";

const theme = createTheme({
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

interface SelectedSession {
  pi: string;
  project: string;
  student: string;
  ts: string;
}

function PassCodeGate({ onUnlock }: { onUnlock: () => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setPiPasscode(draft);
    // Probe the index endpoint to verify the passcode works.
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

export default function PIApp() {
  const [unlocked, setUnlocked] = useState<boolean>(() => !!getPiPasscode());
  const [tree, setTree] = useState<IndexTree | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedSession | null>(null);
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [reviewer, setReviewerState] = useState<string | null>(() =>
    getReviewerName(),
  );

  const refreshIndex = useCallback(async () => {
    setLoadingIndex(true);
    setIndexError(null);
    try {
      const r = await fetchIndex();
      setTree(r.tree);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load index";
      setIndexError(msg);
      if (err instanceof PiApiError && err.status === 401) {
        clearPiPasscode();
        setUnlocked(false);
      }
    } finally {
      setLoadingIndex(false);
    }
  }, []);

  useEffect(() => {
    if (unlocked) refreshIndex();
  }, [unlocked, refreshIndex]);

  const loadBundle = useCallback(async (sel: SelectedSession) => {
    setSelected(sel);
    setBundle(null);
    setBundleLoading(true);
    setBundleError(null);
    try {
      const b = await fetchSessionBundle(sel.pi, sel.project, sel.student, sel.ts);
      setBundle(b);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load session";
      setBundleError(msg);
    } finally {
      setBundleLoading(false);
    }
  }, []);

  const handleSelect = useCallback(
    (pi: string, project: string, student: string, ts: string) => {
      loadBundle({ pi, project, student, ts });
    },
    [loadBundle],
  );

  const handleLogout = useCallback(() => {
    clearPiPasscode();
    setUnlocked(false);
    setTree(null);
    setSelected(null);
    setBundle(null);
  }, []);

  const handleSwitchReviewer = useCallback(() => {
    const next = window.prompt("Reviewer name (shown on feedback you leave):", reviewer ?? "");
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setReviewerName(trimmed);
    setReviewerState(trimmed);
  }, [reviewer]);

  // Prompt for reviewer name on first load (after passcode unlock).
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

  const handleBundleRefresh = useCallback(() => {
    if (selected) loadBundle(selected);
  }, [selected, loadBundle]);

  const reviewerChip = useMemo(
    () => (
      <Tooltip title="Switch reviewer name">
        <Button
          color="inherit"
          startIcon={<PersonOutlineIcon />}
          size="small"
          onClick={handleSwitchReviewer}
          sx={{ textTransform: "none" }}
        >
          {reviewer ?? "Set reviewer"}
        </Button>
      </Tooltip>
    ),
    [reviewer, handleSwitchReviewer],
  );

  if (!unlocked) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <PassCodeGate onUnlock={() => setUnlocked(true)} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <AppBar position="static" elevation={1}>
          <Toolbar variant="dense">
            <Box component="img" src={logoIcon} alt="Logo" sx={{ height: 24, mr: 1 }} />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              ARC — PI Dashboard
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              {reviewerChip}
              <DraftsAppBarWidget
                reviewer={reviewer}
                onReviewerMissing={handleSwitchReviewer}
              />
              <Tooltip title="Refresh index">
                <IconButton color="inherit" size="small" onClick={refreshIndex}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Sign out">
                <IconButton color="inherit" size="small" onClick={handleLogout}>
                  <LogoutIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Toolbar>
        </AppBar>

        <Box sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <Box
            sx={{
              width: 320,
              minWidth: 220,
              borderRight: 1,
              borderColor: "divider",
              overflow: "auto",
              flexShrink: 0,
            }}
          >
            {loadingIndex && !tree ? (
              <Box sx={{ p: 3, textAlign: "center" }}>
                <CircularProgress size={20} />
              </Box>
            ) : indexError ? (
              <Alert severity="error" sx={{ m: 1 }}>
                {indexError}
              </Alert>
            ) : (
              <PINavigator
                tree={tree ?? {}}
                selected={selected}
                onSelect={handleSelect}
              />
            )}
          </Box>

          <Box sx={{ flex: 1, overflow: "auto", minWidth: 0 }}>
            {!selected ? (
              <Box sx={{ p: 4, color: "text.secondary" }}>
                <Typography variant="body1">
                  Select a session from the navigator to begin.
                </Typography>
              </Box>
            ) : bundleLoading ? (
              <Box sx={{ p: 4, textAlign: "center" }}>
                <CircularProgress />
              </Box>
            ) : bundleError ? (
              <Alert severity="error" sx={{ m: 2 }}>
                {bundleError}
              </Alert>
            ) : bundle ? (
              <SessionViewer
                pi={selected.pi}
                project={selected.project}
                student={selected.student}
                sessionTs={selected.ts}
                bundle={bundle}
                reviewer={reviewer}
                onReviewerMissing={handleSwitchReviewer}
                onBundleRefresh={handleBundleRefresh}
              />
            ) : null}
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

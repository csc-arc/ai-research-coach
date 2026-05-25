/**
 * `/pi/drafts` route — diff editor for the working draft set.
 *
 * Side-by-side diff per prompt, in-place editing, per-prompt and bulk
 * downloads, validation warnings, "Discard edits", "Reset all drafts" with
 * a 24h trash + restore safety net, "Download review summary" sidecar
 * markdown.
 */

import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import RestoreIcon from "@mui/icons-material/SettingsBackupRestore";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AGENT_KEYS,
  fetchFeedbackByReviewer,
  type AgentKey,
  type FeedbackByReviewerItem,
} from "./draftsApi";
import {
  clearTrashedDraftSet,
  getActiveDraftSet,
  getTrashedDraftSet,
  loadAndMigrateDraftSet,
  markDownloaded,
  resetDraftPrompt,
  resetDraftSet,
  restoreLastReset,
  updateDraftText,
  type DraftSet,
} from "./draftsStorage";
import {
  filenameForAgent,
  provenanceCommentBlock,
  renderReviewSummary,
} from "./draftsSummary";
import PromptDiffPanel from "./PromptDiffPanel";
import PiAppShell from "./PiAppShell";
import logoIcon from "/logo-white.svg";

function downloadBlob(filename: string, text: string, mime = "text/markdown") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface DraftsScreenProps {
  reviewer: string;
  onLogout: () => void;
  switchReviewer: () => void;
}

function DraftsScreen({ reviewer, onLogout, switchReviewer }: DraftsScreenProps) {
  const [draftSet, setDraftSet] = useState<DraftSet | null>(() =>
    loadAndMigrateDraftSet(reviewer).set,
  );
  const [trashed, setTrashed] = useState<DraftSet | null>(() =>
    getTrashedDraftSet(reviewer),
  );
  const [feedback, setFeedback] = useState<FeedbackByReviewerItem[]>([]);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refreshFeedback = useCallback(async () => {
    try {
      const r = await fetchFeedbackByReviewer(reviewer);
      setFeedback(r.items);
    } catch (e) {
      console.warn("fetchFeedbackByReviewer failed:", e);
    }
  }, [reviewer]);

  useEffect(() => {
    refreshFeedback();
  }, [refreshFeedback]);

  // Track the active draft set (storage may be mutated by other tabs).
  const refreshDraftSet = useCallback(() => {
    setDraftSet(getActiveDraftSet(reviewer));
    setTrashed(getTrashedDraftSet(reviewer));
  }, [reviewer]);

  useEffect(() => {
    const handler = () => refreshDraftSet();
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refreshDraftSet]);

  const includedFeedback = useMemo<FeedbackByReviewerItem[]>(() => {
    if (!draftSet?.last_synth) return [];
    const ids = new Set(draftSet.last_synth.feedback_ids_included);
    return feedback.filter((f) => ids.has(f.head_id));
  }, [draftSet, feedback]);

  const sessionsCount = useMemo(() => {
    const set = new Set<string>();
    for (const f of includedFeedback) {
      set.add(`${f.pi}|${f.project}|${f.student}|${f.session_ts}`);
    }
    return set.size;
  }, [includedFeedback]);

  const dirtyAgents = useMemo<AgentKey[]>(() => {
    if (!draftSet) return [];
    return AGENT_KEYS.filter(
      (k) => draftSet.drafts[k].trim() !== draftSet.originals[k].trim(),
    );
  }, [draftSet]);

  const handleUpdateDraft = useCallback(
    (agent: AgentKey, text: string) => {
      const next = updateDraftText(reviewer, agent, text);
      setDraftSet(next);
    },
    [reviewer],
  );

  const handleDiscard = useCallback(
    (agent: AgentKey) => {
      const next = resetDraftPrompt(reviewer, agent);
      setDraftSet(next);
    },
    [reviewer],
  );

  const handleDownloadOne = useCallback(
    (agent: AgentKey) => {
      if (!draftSet) return;
      const provenance = provenanceCommentBlock(
        draftSet,
        agent,
        includedFeedback.length,
        sessionsCount,
      );
      const body = `${provenance}\n\n${draftSet.drafts[agent]}`;
      downloadBlob(filenameForAgent(agent), body);
      const next = markDownloaded(reviewer, agent);
      setDraftSet(next);
    },
    [draftSet, includedFeedback.length, reviewer, sessionsCount],
  );

  const handleDownloadAll = useCallback(async () => {
    if (!draftSet) return;
    let i = 0;
    for (const agent of dirtyAgents) {
      // Stagger so the browser doesn't collapse triggers into one save dialog.
      await new Promise((resolve) => setTimeout(resolve, 200 * i));
      handleDownloadOne(agent);
      i += 1;
    }
  }, [draftSet, dirtyAgents, handleDownloadOne]);

  const handleDownloadSummary = useCallback(() => {
    if (!draftSet) return;
    const md = renderReviewSummary(draftSet, includedFeedback);
    downloadBlob(`pi-drafts-summary-${draftSet.draft_set_id.slice(0, 8)}.md`, md);
  }, [draftSet, includedFeedback]);

  const handleResetAll = useCallback(() => {
    resetDraftSet(reviewer);
    refreshDraftSet();
    setResetAllOpen(false);
    setInfo("Draft set moved to trash. Restore is available for the next 24 hours.");
  }, [reviewer, refreshDraftSet]);

  const handleRestore = useCallback(() => {
    const next = restoreLastReset(reviewer);
    setRestoreOpen(false);
    if (next) {
      setDraftSet(next);
      setTrashed(null);
      clearTrashedDraftSet(reviewer);
      setInfo(`Restored draft set ${next.draft_set_id.slice(0, 8)}.`);
    } else {
      setError("No restorable draft set found in trash (it may have expired).");
    }
  }, [reviewer]);

  const goToDashboard = () => {
    window.location.assign("/pi");
  };

  if (!draftSet) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <AppBar position="static" elevation={1}>
          <Toolbar variant="dense">
            <Box component="img" src={logoIcon} alt="Logo" sx={{ height: 24, mr: 1 }} />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              ARC — PI Draft Editor
            </Typography>
            <Button color="inherit" size="small" onClick={goToDashboard} endIcon={<OpenInNewIcon />}>
              Back to /pi
            </Button>
          </Toolbar>
        </AppBar>
        <Box sx={{ p: 4 }}>
          <Alert severity="info">
            No active draft set for {reviewer}. Click <strong>Synthesize all my feedback</strong> in the
            <code>/pi</code> dashboard to create one.
          </Alert>
          {trashed && (
            <Alert
              severity="warning"
              sx={{ mt: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => setRestoreOpen(true)}>
                  Restore last reset
                </Button>
              }
            >
              A previously-reset draft set is available in trash (created{" "}
              {trashed.created_at}). It will expire 24 hours after creation.
            </Alert>
          )}
        </Box>
        {restoreOpen && (
          <RestoreDialog
            trashed={trashed}
            currentExists={false}
            onCancel={() => setRestoreOpen(false)}
            onConfirm={handleRestore}
          />
        )}
      </Box>
    );
  }

  const last = draftSet.last_synth;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppBar position="static" elevation={1}>
        <Toolbar variant="dense">
          <Box component="img" src={logoIcon} alt="Logo" sx={{ height: 24, mr: 1 }} />
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            ARC — PI Draft Editor
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title="Switch reviewer name">
              <Button
                color="inherit"
                size="small"
                startIcon={<PersonOutlineIcon />}
                onClick={switchReviewer}
                sx={{ textTransform: "none" }}
              >
                {reviewer}
              </Button>
            </Tooltip>
            <Button
              color="inherit"
              size="small"
              onClick={goToDashboard}
              endIcon={<OpenInNewIcon />}
              sx={{ textTransform: "none" }}
            >
              Back to /pi
            </Button>
            <Tooltip title="Sign out">
              <IconButton color="inherit" size="small" onClick={onLogout}>
                <LogoutIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Draft set <code>{draftSet.draft_set_id.slice(0, 8)}…</code> · created{" "}
            {draftSet.created_at}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Baseline: csc-arc/ai-research-coach@
            <code>{draftSet.baseline_sha?.slice(0, 7) ?? "(not pinned)"}</code>
          </Typography>
          {last ? (
            <Typography variant="body2" color="text.secondary">
              {includedFeedback.length} feedback item
              {includedFeedback.length === 1 ? "" : "s"} folded in across{" "}
              {sessionsCount} session{sessionsCount === 1 ? "" : "s"} · last synth at{" "}
              {last.ts}
              {last.agents_md_source === "fallback" && (
                <> · synthesized using offline AGENTS.md fallback</>
              )}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No synthesis run yet.
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            color="error"
            startIcon={<RestoreIcon />}
            onClick={() => setResetAllOpen(true)}
          >
            Reset all drafts
          </Button>
          <Button
            variant="contained"
            disabled={dirtyAgents.length === 0}
            onClick={handleDownloadAll}
          >
            Download all changed prompts ({dirtyAgents.length})
          </Button>
          <Button
            variant="outlined"
            disabled={!last}
            onClick={handleDownloadSummary}
          >
            Download review summary
          </Button>
          {trashed && (
            <Button
              variant="text"
              color="warning"
              startIcon={<RestoreIcon />}
              onClick={() => setRestoreOpen(true)}
            >
              Restore last reset draft set
            </Button>
          )}
        </Stack>

        {AGENT_KEYS.map((agent) => (
          <PromptDiffPanel
            key={agent}
            agent={agent}
            draftSet={draftSet}
            onUpdateDraft={(text) => handleUpdateDraft(agent, text)}
            onDiscardEdits={() => handleDiscard(agent)}
            onDownload={() => handleDownloadOne(agent)}
            downloadDisabled={
              draftSet.drafts[agent].trim() === draftSet.originals[agent].trim()
            }
          />
        ))}
      </Box>

      {resetAllOpen && (
        <ResetAllDialog
          dirtyAgents={dirtyAgents}
          downloadedCount={
            AGENT_KEYS.filter((k) => draftSet.downloads[k] != null).length
          }
          feedbackCount={includedFeedback.length}
          onCancel={() => setResetAllOpen(false)}
          onConfirm={handleResetAll}
        />
      )}

      {restoreOpen && (
        <RestoreDialog
          trashed={trashed}
          currentExists={true}
          onCancel={() => setRestoreOpen(false)}
          onConfirm={handleRestore}
        />
      )}

      <Snackbar
        open={!!info}
        autoHideDuration={6000}
        onClose={() => setInfo(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" onClose={() => setInfo(null)}>
          {info}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!error}
        autoHideDuration={8000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Box>
  );
}

interface ResetAllDialogProps {
  dirtyAgents: AgentKey[];
  downloadedCount: number;
  feedbackCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function ResetAllDialog({
  dirtyAgents,
  downloadedCount,
  feedbackCount,
  onCancel,
  onConfirm,
}: ResetAllDialogProps) {
  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Reset all drafts?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          {dirtyAgents.length} prompt{dirtyAgents.length === 1 ? "" : "s"} modified ·{" "}
          {feedbackCount} feedback item{feedbackCount === 1 ? "" : "s"} folded in.
        </Typography>
        {downloadedCount > 0 && dirtyAgents.length > 0 && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            You have unsaved changes since last download for {dirtyAgents.length}{" "}
            prompt{dirtyAgents.length === 1 ? "" : "s"}. Reset moves the draft set to
            trash; you can restore for ~24 hours.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" onClick={onConfirm}>
          Reset
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface RestoreDialogProps {
  trashed: DraftSet | null;
  currentExists: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RestoreDialog({
  trashed,
  currentExists,
  onCancel,
  onConfirm,
}: RestoreDialogProps) {
  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Restore the trashed draft set?</DialogTitle>
      <DialogContent>
        {trashed ? (
          <Typography variant="body2">
            Restoring draft set{" "}
            <code>{trashed.draft_set_id.slice(0, 8)}…</code> created{" "}
            {trashed.created_at}.
          </Typography>
        ) : (
          <CircularProgress />
        )}
        {currentExists && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            A draft set is currently active. Restoring will replace it.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={onConfirm}>
          Restore
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function PIDraftsApp() {
  return (
    <PiAppShell>
      {({ reviewer, switchReviewer, onLogout }) =>
        reviewer ? (
          <DraftsScreen
            reviewer={reviewer}
            onLogout={onLogout}
            switchReviewer={switchReviewer}
          />
        ) : (
          <Box sx={{ p: 4 }}>
            <Alert severity="info">
              Set a reviewer name to use the drafts editor.{" "}
              <Button size="small" onClick={switchReviewer}>
                Set reviewer
              </Button>
            </Alert>
          </Box>
        )
      }
    </PiAppShell>
  );
}

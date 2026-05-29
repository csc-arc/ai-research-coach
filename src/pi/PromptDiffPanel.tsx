import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import RestoreIcon from "@mui/icons-material/SettingsBackupRestore";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { MarkdownContent } from "../react-ai-chat";
import type { AgentKey } from "./draftsApi";
import type { DraftSet, LastSynth } from "./draftsStorage";

// Lazy import keeps the diff library out of the main /pi bundle. The
// /pi/drafts route is the only place that uses it.
const ReactDiffViewer = lazy(() => import("react-diff-viewer-continued"));

const PRETTY_FILE_NAME: Record<AgentKey, string> = {
  coach: "coach-instructions.md",
  fast_eval: "fast-eval-prompt.md",
  deep_eval: "deep-eval-prompt.md",
};

const PRETTY_AGENT_LABEL: Record<AgentKey, string> = {
  coach: "Coach prompt",
  fast_eval: "Fast-eval prompt",
  deep_eval: "Deep-eval prompt",
};

interface PromptDiffPanelProps {
  agent: AgentKey;
  draftSet: DraftSet;
  onUpdateDraft: (text: string) => void;
  onDiscardEdits: () => void;
  onDownload: () => void;
  downloadDisabled: boolean;
}

export default function PromptDiffPanel({
  agent,
  draftSet,
  onUpdateDraft,
  onDiscardEdits,
  onDownload,
  downloadDisabled,
}: PromptDiffPanelProps) {
  const original = draftSet.originals[agent];
  const draft = draftSet.drafts[agent];
  const lastSynth = draftSet.last_synth;
  const synthSummary = lastSynth?.summary[agent] ?? null;
  const synthRationale = lastSynth?.rationale[agent] ?? null;
  const warnings = lastSynth?.warnings[agent] ?? [];
  const downloadInfo = draftSet.downloads[agent];

  const dirty = draft.trim() !== original.trim();

  const [splitView, setSplitView] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editorText, setEditorText] = useState(draft);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const handleStartEdit = useCallback(() => {
    setEditorText(draft);
    setEditing(true);
  }, [draft]);

  const handleEditCommit = useCallback(() => {
    if (editorText !== draft) onUpdateDraft(editorText);
    setEditing(false);
  }, [editorText, draft, onUpdateDraft]);

  const handleEditCancel = useCallback(() => {
    setEditorText(draft);
    setEditing(false);
  }, [draft]);

  const downloadStaleSinceEdit = useMemo(() => {
    if (!downloadInfo) return false;
    const ts = Date.parse(downloadInfo.last_downloaded_at);
    // We don't track per-edit timestamps; use last_synth.ts as an upper
    // bound on "the most recent semantic change", and the download is
    // stale if the user has edited *after* downloading. Without a per-edit
    // timestamp we conservatively show "stale" whenever the dirty draft
    // length disagrees with what was likely downloaded — i.e. whenever
    // a download exists at all and the draft is currently dirty.
    return Number.isFinite(ts) && dirty;
  }, [downloadInfo, dirty]);

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        p: 1.5,
        mb: 2,
        bgcolor: "background.paper",
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          {PRETTY_AGENT_LABEL[agent]}{" "}
          <Typography component="span" variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
            ({PRETTY_FILE_NAME[agent]})
          </Typography>
        </Typography>
        {dirty && <Chip size="small" label="modified" color="primary" />}
        {downloadInfo && (
          <Chip
            size="small"
            label={
              downloadStaleSinceEdit
                ? `unsaved changes since download`
                : `downloaded ${downloadInfo.last_downloaded_at.slice(11, 16)}`
            }
            color={downloadStaleSinceEdit ? "warning" : "default"}
            variant="outlined"
          />
        )}
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={splitView}
              onChange={(e) => setSplitView(e.target.checked)}
            />
          }
          label={<Typography variant="caption">split</Typography>}
          sx={{ mr: 0 }}
        />
        <Button
          size="small"
          startIcon={<RestoreIcon />}
          onClick={() => setDiscardOpen(true)}
          disabled={!dirty}
        >
          Discard edits
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<DownloadIcon />}
          onClick={onDownload}
          disabled={downloadDisabled}
        >
          Download
        </Button>
      </Stack>

      {warnings.length > 0 && (
        <Alert
          severity="warning"
          icon={<WarningAmberIcon />}
          sx={{ mb: 1 }}
          action={
            <Button
              size="small"
              color="inherit"
              onClick={() => setWarningsOpen((o) => !o)}
            >
              {warningsOpen ? "Hide" : `Show ${warnings.length}`}
            </Button>
          }
        >
          {warnings.length} validation warning
          {warnings.length === 1 ? "" : "s"} flagged by the synthesizer
        </Alert>
      )}
      <Collapse in={warningsOpen}>
        <Box sx={{ mb: 1, pl: 2 }}>
          {warnings.map((w, i) => (
            <Typography key={i} variant="caption" component="div">
              • {w}
            </Typography>
          ))}
        </Box>
      </Collapse>

      {editing ? (
        <Box>
          <TextField
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            multiline
            fullWidth
            minRows={20}
            maxRows={40}
            sx={{
              "& textarea": {
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
              },
            }}
          />
          <Box sx={{ mt: 1, display: "flex", justifyContent: "flex-end", gap: 1 }}>
            <Button size="small" onClick={handleEditCancel}>
              Cancel
            </Button>
            <Button size="small" variant="contained" onClick={handleEditCommit}>
              Save edits
            </Button>
          </Box>
        </Box>
      ) : (
        <Box>
          <Suspense
            fallback={
              <Box sx={{ p: 2, color: "text.secondary" }}>
                Loading diff viewer…
              </Box>
            }
          >
            <ReactDiffViewer
              oldValue={original}
              newValue={draft}
              splitView={splitView}
              showDiffOnly={false}
              hideLineNumbers={false}
              useDarkTheme={false}
              styles={{
                contentText: {
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: "12px",
                },
              }}
            />
          </Suspense>
          <Box sx={{ mt: 1, display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="small"
              startIcon={<EditIcon />}
              onClick={handleStartEdit}
            >
              Edit draft
            </Button>
          </Box>
        </Box>
      )}

      {synthSummary && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" sx={{ fontStyle: "italic" }}>
            <strong>Synthesis summary:</strong> {synthSummary}
          </Typography>
          {synthRationale && (
            <Box>
              <Button
                size="small"
                onClick={() => setRationaleOpen((o) => !o)}
                sx={{ textTransform: "none", mt: 0.5 }}
              >
                {rationaleOpen ? "Hide" : "Show"} full rationale
              </Button>
              <Collapse in={rationaleOpen}>
                <Box
                  sx={{
                    p: 1,
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    mt: 0.5,
                  }}
                >
                  <MarkdownContent content={synthRationale} />
                </Box>
              </Collapse>
            </Box>
          )}
        </Box>
      )}

      <DiscardEditsDialog
        open={discardOpen}
        agent={agent}
        original={original}
        draft={draft}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          onDiscardEdits();
          setDiscardOpen(false);
        }}
      />
    </Box>
  );
}

// Re-export so TS imports work cleanly elsewhere.
export type { LastSynth };

interface DiscardEditsDialogProps {
  open: boolean;
  agent: AgentKey;
  original: string;
  draft: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function DiscardEditsDialog({
  open,
  agent,
  original,
  draft,
  onCancel,
  onConfirm,
}: DiscardEditsDialogProps) {
  const linesToDiscard = useMemo(() => {
    if (original === draft) return 0;
    // Rough metric: count line diffs.
    const a = original.split("\n");
    const b = draft.split("\n");
    return Math.abs(a.length - b.length) + a.filter((line, i) => line !== b[i]).length;
  }, [original, draft]);

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Discard edits to {PRETTY_AGENT_LABEL[agent]}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          Roughly {linesToDiscard} line{linesToDiscard === 1 ? "" : "s"} will be reverted to the original. Other prompts are unaffected.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" onClick={onConfirm}>
          Discard
        </Button>
      </DialogActions>
    </Dialog>
  );
}

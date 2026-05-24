import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { useEffect, useMemo, useState } from "react";
import {
  PromptHistoryEntry,
  PromptMode,
  PromptSelector,
  ReplayResponse,
  fetchPromptAtSha,
  fetchPromptHistory,
  postReplay,
} from "./piApi";
import { MarkdownContent } from "../react-ai-chat";

type AgentKey = "coach" | "fast_eval" | "deep_eval";

const PROMPT_FILE_BY_AGENT: Record<AgentKey, string> = {
  // The PI dashboard uses instructions-v1.md (the split-recording-mode
  // coach prompt) as the historical anchor for "coach" replays.
  coach: "instructions-v1",
  fast_eval: "fast-eval",
  deep_eval: "deep-eval",
};

interface AgentPromptControlsProps {
  agent: AgentKey;
  selector: PromptSelector;
  onChange: (next: PromptSelector) => void;
  originalSha: string | null;
}

function AgentPromptControls({
  agent,
  selector,
  onChange,
  originalSha,
}: AgentPromptControlsProps) {
  const [history, setHistory] = useState<PromptHistoryEntry[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<string>("");
  const [seeding, setSeeding] = useState(false);

  const promptName = PROMPT_FILE_BY_AGENT[agent];

  useEffect(() => {
    setLoadingHistory(true);
    setHistoryError(null);
    fetchPromptHistory(promptName)
      .then((r) => setHistory(r.history))
      .catch((e) =>
        setHistoryError(e instanceof Error ? e.message : "Failed to load history"),
      )
      .finally(() => setLoadingHistory(false));
  }, [promptName]);

  // Seed the inline editor whenever we land in text mode without content.
  // Covers two cases: the dialog opens in text mode (the new default), and
  // the user switches *back* to text mode after picking SHA/Original.
  useEffect(() => {
    if (selector.mode !== "text") return;
    if (selector.value && selector.value.length > 0) return;
    let cancelled = false;
    setSeeding(true);
    setTextDraft("Loading prompt content…");
    const sha = originalSha || "live";
    fetchPromptAtSha(promptName, sha)
      .then((r) => {
        if (cancelled) return;
        setTextDraft(r.content);
        onChange({ mode: "text", value: r.content });
      })
      .catch((e) => {
        if (cancelled) return;
        setTextDraft("");
        setHistoryError(e instanceof Error ? e.message : "Failed to seed text");
      })
      .finally(() => {
        if (!cancelled) setSeeding(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector.mode, originalSha, promptName]);

  const downloadText = () => {
    const value = textDraft;
    const blob = new Blob([value], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${promptName}-edited.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ textTransform: "capitalize", mb: 0.5 }}>
        {agent.replace("_", "-")} prompt
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Mode</InputLabel>
          <Select
            label="Mode"
            value={selector.mode}
            onChange={(e) => {
              const next = e.target.value as PromptMode;
              if (next === "text") {
                // Reset value so the seeding effect re-fetches.
                onChange({ mode: "text", value: undefined });
              } else {
                onChange({ mode: next, value: undefined });
              }
            }}
          >
            <MenuItem value="text">Edit inline</MenuItem>
            <MenuItem value="original" disabled={!originalSha}>
              Original (pinned)
            </MenuItem>
            <MenuItem value="sha">Pick historical SHA</MenuItem>
          </Select>
        </FormControl>
        {selector.mode === "sha" && (
          <FormControl size="small" sx={{ minWidth: 200, flex: 1 }}>
            <InputLabel>SHA</InputLabel>
            <Select
              label="SHA"
              value={selector.value || ""}
              onChange={(e) =>
                onChange({ mode: "sha", value: String(e.target.value) })
              }
              displayEmpty
              renderValue={(value) => {
                if (!value) return <em>Select…</em>;
                const v = String(value);
                if (v === "live") return "Live (head of main)";
                const entry = history?.find((h) => h.sha === v);
                if (!entry) return v.slice(0, 7);
                return `${v.slice(0, 7)} — ${entry.commit_subject}`.slice(0, 80);
              }}
            >
              <MenuItem value="live">Live (head of main)</MenuItem>
              {loadingHistory && (
                <MenuItem disabled>
                  <CircularProgress size={16} />
                </MenuItem>
              )}
              {historyError && <MenuItem disabled>{historyError}</MenuItem>}
              {history?.map((h) => (
                <MenuItem key={h.sha} value={h.sha}>
                  {h.sha.slice(0, 7)} — {h.commit_subject}
                  {h.committed_at && ` (${h.committed_at.slice(0, 10)})`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>

      {selector.mode === "text" && (
        <Box sx={{ mt: 1 }}>
          <TextField
            value={textDraft}
            onChange={(e) => {
              setTextDraft(e.target.value);
              onChange({ mode: "text", value: e.target.value });
            }}
            multiline
            fullWidth
            minRows={5}
            maxRows={14}
            disabled={seeding}
            placeholder={seeding ? "Loading prompt content…" : ""}
            sx={{
              "& textarea": {
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
              },
            }}
          />
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {seeding
                ? "Loading…"
                : `Seeded from ${originalSha ? `pinned SHA (${originalSha.slice(0, 7)})` : "head of main"} — edit freely.`}
            </Typography>
            <Button
              size="small"
              startIcon={<DownloadIcon fontSize="small" />}
              onClick={downloadText}
              disabled={seeding || !textDraft}
            >
              Download
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

interface ReplayPanelProps {
  open: boolean;
  onClose: () => void;
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  turn: number;
  originalSha: string | null;
  /** Used as a placeholder in the side-by-side comparison. */
  recordedFastEvalForTurn?: string | null;
  /** End-of-session deep-eval markdown (the only "original" we have). */
  recordedDeepEval?: string | null;
}

export default function ReplayPanel({
  open,
  onClose,
  pi,
  project,
  student,
  sessionTs,
  turn,
  originalSha,
  recordedFastEvalForTurn,
  recordedDeepEval,
}: ReplayPanelProps) {
  // All three default to "Edit inline" — the primary use of replay is to
  // try ad-hoc prompt edits and see how the pipeline responds. The
  // textareas seed themselves from the session's pinned SHA (or head of
  // main if none was recorded). PIs who want to A/B against a historical
  // version can switch the Mode dropdown.
  const [coachPrompt, setCoachPrompt] = useState<PromptSelector>({
    mode: "text",
    value: undefined,
  });
  const [fastEvalPrompt, setFastEvalPrompt] = useState<PromptSelector>({
    mode: "text",
    value: undefined,
  });
  const [deepEvalPrompt, setDeepEvalPrompt] = useState<PromptSelector>({
    mode: "text",
    value: undefined,
  });
  const [coachModelOverride, setCoachModelOverride] = useState("");
  const [fastEvalModelOverride, setFastEvalModelOverride] = useState("");
  const [deepEvalModelOverride, setDeepEvalModelOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResponse | null>(null);

  // Re-initialize prompt selectors when the dialog reopens for a new turn
  // (otherwise stale state from a previous replay would leak in).
  useEffect(() => {
    if (!open) return;
    setCoachPrompt({ mode: "text", value: undefined });
    setFastEvalPrompt({ mode: "text", value: undefined });
    setDeepEvalPrompt({ mode: "text", value: undefined });
    setResult(null);
    setError(null);
  }, [open, originalSha, turn]);

  const runReplay = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await postReplay({
        pi,
        project,
        student,
        session_ts: sessionTs,
        turn,
        coach_prompt: coachPrompt,
        fast_eval_prompt: fastEvalPrompt,
        deep_eval_prompt: deepEvalPrompt,
        coach_model: coachModelOverride.trim() || undefined,
        fast_eval_model: fastEvalModelOverride.trim() || undefined,
        deep_eval_model: deepEvalModelOverride.trim() || undefined,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replay failed");
    } finally {
      setLoading(false);
    }
  };

  const helperBanner = useMemo(
    () =>
      "Edit any of the prompts below and click Run replay to see how this user turn would have been handled under your changes. Each textarea is pre-loaded with the prompt as it was for this session — make changes, run, compare to the original output. Switch the Mode dropdown if you'd rather pin to a specific historical commit.",
    [],
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Replay turn {turn}
        <Typography variant="caption" component="div" sx={{ color: "text.secondary" }}>
          {pi} / {project} / {student} / {sessionTs}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          {helperBanner}
        </Alert>

        <Stack spacing={2}>
          <AgentPromptControls
            agent="coach"
            selector={coachPrompt}
            onChange={setCoachPrompt}
            originalSha={originalSha}
          />
          <AgentPromptControls
            agent="fast_eval"
            selector={fastEvalPrompt}
            onChange={setFastEvalPrompt}
            originalSha={originalSha}
          />
          <AgentPromptControls
            agent="deep_eval"
            selector={deepEvalPrompt}
            onChange={setDeepEvalPrompt}
            originalSha={originalSha}
          />

          <Divider>Optional model overrides</Divider>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="Coach model"
              value={coachModelOverride}
              onChange={(e) => setCoachModelOverride(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Fast-eval model"
              value={fastEvalModelOverride}
              onChange={(e) => setFastEvalModelOverride(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Deep-eval model"
              value={deepEvalModelOverride}
              onChange={(e) => setDeepEvalModelOverride(e.target.value)}
              sx={{ flex: 1 }}
            />
          </Stack>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}

        {result && (
          <Box sx={{ mt: 3 }}>
            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle1" gutterBottom>
              Results
            </Typography>
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2">Coach response (replay)</Typography>
                <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <MarkdownContent content={result.coach_response || "(empty)"} />
                </Box>
              </Box>
              <Box>
                <Typography variant="subtitle2">Fast-eval (replay)</Typography>
                <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <MarkdownContent content={result.fast_eval_md || "(empty)"} />
                </Box>
              </Box>
              {recordedFastEvalForTurn != null && (
                <Box>
                  <Typography variant="subtitle2">Fast-eval (originally recorded for this turn)</Typography>
                  <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, opacity: 0.85 }}>
                    <MarkdownContent content={recordedFastEvalForTurn || "(none)"} />
                  </Box>
                </Box>
              )}
              <Box>
                <Typography variant="subtitle2">Deep-eval (replay)</Typography>
                <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <MarkdownContent content={result.deep_eval_md || "(empty)"} />
                </Box>
              </Box>
              {recordedDeepEval != null && (
                <Box>
                  <Typography variant="subtitle2">
                    Deep-eval (end-of-session, only historical anchor we have)
                  </Typography>
                  <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, opacity: 0.85 }}>
                    <MarkdownContent content={recordedDeepEval || "(none)"} />
                  </Box>
                </Box>
              )}
              <Typography variant="caption" color="text.secondary">
                Models used — coach: {result.models_used.coach} ·{" "}
                fast-eval: {result.models_used.fast_eval} ·{" "}
                deep-eval: {result.models_used.deep_eval}
              </Typography>
            </Stack>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          onClick={runReplay}
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} /> : null}
        >
          Run replay
        </Button>
      </DialogActions>
    </Dialog>
  );
}

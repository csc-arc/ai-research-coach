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
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import UpdateIcon from "@mui/icons-material/Update";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PromptHistoryEntry,
  PromptSelector,
  PromptsDivergenceResponse,
  ReplayResponse,
  fetchPromptAtSha,
  fetchPromptHistory,
  postReplay,
} from "./piApi";
import { MarkdownContent } from "../react-ai-chat";
import { getActiveDraftSet, type DraftSet } from "./draftsStorage";

type AgentKey = "coach" | "fast_eval" | "deep_eval";

const PROMPT_FILE_BY_AGENT: Record<AgentKey, string> = {
  // The PI dashboard uses coach-instructions.md (the split-recording-mode
  // coach prompt) as the historical anchor for "coach" replays. The backend
  // falls back to the pre-rename instructions-v1.md for older pinned SHAs.
  coach: "coach-instructions",
  fast_eval: "fast-eval",
  deep_eval: "deep-eval",
};

interface AgentPromptControlsProps {
  agent: AgentKey;
  selector: PromptSelector;
  onChange: (next: PromptSelector) => void;
  originalSha: string | null;
  /**
   * The reviewer's active draft set for this prompt, if any. When present,
   * exposes a "Working draft" mode in the dropdown that pins the prompt to
   * the in-progress draft text.
   */
  draftSet: DraftSet | null;
  /** True iff the visible mode in this picker is "Working draft". */
  isWorkingDraftMode: boolean;
  /** Switch to Working draft mode (seeds the inline value). */
  onSwitchToWorkingDraft: () => void;
}

function AgentPromptControls({
  agent,
  selector,
  onChange,
  originalSha,
  draftSet,
  isWorkingDraftMode,
  onSwitchToWorkingDraft,
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

  // Translate the underlying PromptSelector into a 5-way UI mode so that
  // "Working draft", "Currently deployed (live main)" and "Original (pinned)"
  // are each their own first-class dropdown entries, distinct from "Pick
  // historical SHA".
  type UiMode = "working_draft" | "text" | "live" | "original" | "sha";
  const uiMode: UiMode = isWorkingDraftMode
    ? "working_draft"
    : selector.mode === "text"
      ? "text"
      : selector.mode === "original"
        ? "original"
        : selector.value === "live"
          ? "live"
          : "sha";

  const setUiMode = (next: UiMode) => {
    if (next === "working_draft") {
      onSwitchToWorkingDraft();
    } else if (next === "text") {
      // Reset value so the seeding effect re-fetches.
      onChange({ mode: "text", value: undefined });
    } else if (next === "live") {
      onChange({ mode: "sha", value: "live" });
    } else if (next === "original") {
      onChange({ mode: "original", value: undefined });
    } else {
      onChange({ mode: "sha", value: undefined });
    }
  };

  const draftAvailable = draftSet != null;

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ textTransform: "capitalize", mb: 0.5 }}>
        {agent.replace("_", "-")} prompt
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel>Mode</InputLabel>
          <Select
            label="Mode"
            value={uiMode}
            onChange={(e) => setUiMode(e.target.value as UiMode)}
          >
            {draftAvailable && (
              <MenuItem value="working_draft">Working draft</MenuItem>
            )}
            <MenuItem value="text">Edit inline</MenuItem>
            <MenuItem value="live">Currently deployed (live main)</MenuItem>
            <MenuItem value="original" disabled={!originalSha}>
              Original (pinned)
            </MenuItem>
            <MenuItem value="sha">Pick historical SHA</MenuItem>
          </Select>
        </FormControl>
        {uiMode === "sha" && (
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
                const entry = history?.find((h) => h.sha === v);
                if (!entry) return v.slice(0, 7);
                return `${v.slice(0, 7)} — ${entry.commit_subject}`.slice(0, 80);
              }}
            >
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
            value={selector.value ?? textDraft}
            onChange={(e) => {
              setTextDraft(e.target.value);
              // Typing into a working_draft-mode textarea silently breaks
              // the link to the persistent draft (per plan §D4): the value
              // is preserved but the visible mode flips to "Edit inline" so
              // the PI knows their typing is ephemeral and won't write back
              // to /pi/drafts.
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
                : isWorkingDraftMode
                  ? `Loaded from your working draft (set ${draftSet!.draft_set_id.slice(0, 8)}). Edits here are ephemeral.`
                  : `Seeded from ${originalSha ? `pinned SHA (${originalSha.slice(0, 7)})` : "head of main"} — edit freely.`}
            </Typography>
            <Button
              size="small"
              startIcon={<DownloadIcon fontSize="small" />}
              onClick={downloadText}
              disabled={seeding || (!textDraft && !selector.value)}
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
  /** Per-prompt divergence info — used to surface "main has moved since
   * this session" with a one-click switch to "Currently deployed". */
  divergence: PromptsDivergenceResponse | null;
  /** Used as a placeholder in the side-by-side comparison. */
  recordedFastEvalForTurn?: string | null;
  /** End-of-session deep-eval markdown (the only "original" we have). */
  recordedDeepEval?: string | null;
  /**
   * Reviewer name (the value gated by the passcode). When set and a draft
   * set exists in localStorage for this reviewer, all three pickers default
   * to "Working draft" mode so PIs can quickly verify a draft against a
   * single user turn. (Phase D4.)
   */
  reviewer?: string | null;
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
  divergence,
  recordedFastEvalForTurn,
  recordedDeepEval,
  reviewer,
}: ReplayPanelProps) {
  // Snapshot of the reviewer's working draft set, taken whenever the dialog
  // opens. We deliberately don't subscribe to live updates: replay is a
  // verification step, not an editing surface, and PIs would be confused by
  // mid-replay textarea content changes if they edited /pi/drafts in
  // another tab.
  const [draftSet, setDraftSet] = useState<DraftSet | null>(null);

  // Tracks whether each picker is currently bound to the working draft.
  // Typing into the textarea breaks this link (we set the flag to false in
  // the same setter that flipped the underlying selector to inline-text)
  // so the dropdown reverts to "Edit inline" — see Phase D4.
  const [coachIsDraft, setCoachIsDraft] = useState(false);
  const [fastEvalIsDraft, setFastEvalIsDraft] = useState(false);
  const [deepEvalIsDraft, setDeepEvalIsDraft] = useState(false);

  // All three default to "Edit inline" when no draft set exists for the
  // active reviewer. With drafts present, they default to "Working draft"
  // (see the open-effect below). Either way the textareas seed themselves
  // from the appropriate source.
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

  // Result section sits below 3 large prompt textareas in the same dialog;
  // auto-scroll to it so reviewers don't think the click did nothing.
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!result) return;
    // Defer one tick so the result block is mounted before we scroll.
    const t = setTimeout(() => {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => clearTimeout(t);
  }, [result]);

  const scrollToResult = () => {
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Re-initialize prompt selectors when the dialog reopens for a new turn
  // (otherwise stale state from a previous replay would leak in).
  useEffect(() => {
    if (!open) return;
    const ds = reviewer ? getActiveDraftSet(reviewer) : null;
    setDraftSet(ds);
    if (ds) {
      // Default each picker to Working draft mode — that's the whole point
      // of this dialog when a synthesis has been run.
      setCoachPrompt({ mode: "text", value: ds.drafts.coach });
      setFastEvalPrompt({ mode: "text", value: ds.drafts.fast_eval });
      setDeepEvalPrompt({ mode: "text", value: ds.drafts.deep_eval });
      setCoachIsDraft(true);
      setFastEvalIsDraft(true);
      setDeepEvalIsDraft(true);
    } else {
      setCoachPrompt({ mode: "text", value: undefined });
      setFastEvalPrompt({ mode: "text", value: undefined });
      setDeepEvalPrompt({ mode: "text", value: undefined });
      setCoachIsDraft(false);
      setFastEvalIsDraft(false);
      setDeepEvalIsDraft(false);
    }
    setResult(null);
    setError(null);
  }, [open, originalSha, turn, reviewer]);

  // The change handler the children call when *they* mutate the selector.
  // We use it to detect a transition that breaks the working-draft link
  // (anything that's not exactly the draft text → no longer "Working draft"
  // mode). The setUiMode-driven path bypasses this by calling the setters
  // directly via the dedicated working-draft helpers below.
  const wrapSetter = (
    agent: AgentKey,
    set: (s: PromptSelector) => void,
    setIsDraft: (b: boolean) => void,
  ) => (next: PromptSelector) => {
    set(next);
    if (!draftSet) {
      setIsDraft(false);
      return;
    }
    const expected = draftSet.drafts[agent];
    setIsDraft(next.mode === "text" && next.value === expected);
  };

  const setCoachFromChild = wrapSetter("coach", setCoachPrompt, setCoachIsDraft);
  const setFastEvalFromChild = wrapSetter(
    "fast_eval",
    setFastEvalPrompt,
    setFastEvalIsDraft,
  );
  const setDeepEvalFromChild = wrapSetter(
    "deep_eval",
    setDeepEvalPrompt,
    setDeepEvalIsDraft,
  );

  const switchOneToWorkingDraft = (agent: AgentKey) => {
    if (!draftSet) return;
    const value = draftSet.drafts[agent];
    if (agent === "coach") {
      setCoachPrompt({ mode: "text", value });
      setCoachIsDraft(true);
    } else if (agent === "fast_eval") {
      setFastEvalPrompt({ mode: "text", value });
      setFastEvalIsDraft(true);
    } else {
      setDeepEvalPrompt({ mode: "text", value });
      setDeepEvalIsDraft(true);
    }
  };

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

  const divergenceSummary = useMemo(() => {
    if (!divergence?.comparable || !divergence.any_modified) return null;
    const modified = Object.entries(divergence.prompts).filter(
      ([, v]) => v.modified,
    );
    if (modified.length === 0) return null;
    const totalCommits = modified.reduce(
      (sum, [, v]) => sum + (v.commits?.length ?? 0),
      0,
    );
    const fileLabels = modified
      .map(([f]) => f.replace(/\.md$/, "").replace("coach-instructions", "coach"))
      .join(", ");
    return { fileLabels, totalCommits, fileCount: modified.length };
  }, [divergence]);

  const switchAllToLive = () => {
    setCoachPrompt({ mode: "sha", value: "live" });
    setFastEvalPrompt({ mode: "sha", value: "live" });
    setDeepEvalPrompt({ mode: "sha", value: "live" });
    setCoachIsDraft(false);
    setFastEvalIsDraft(false);
    setDeepEvalIsDraft(false);
  };

  const switchAllToText = () => {
    setCoachPrompt({ mode: "text", value: undefined });
    setFastEvalPrompt({ mode: "text", value: undefined });
    setDeepEvalPrompt({ mode: "text", value: undefined });
    setCoachIsDraft(false);
    setFastEvalIsDraft(false);
    setDeepEvalIsDraft(false);
  };

  const switchAllToWorkingDraft = () => {
    if (!draftSet) return;
    setCoachPrompt({ mode: "text", value: draftSet.drafts.coach });
    setFastEvalPrompt({ mode: "text", value: draftSet.drafts.fast_eval });
    setDeepEvalPrompt({ mode: "text", value: draftSet.drafts.deep_eval });
    setCoachIsDraft(true);
    setFastEvalIsDraft(true);
    setDeepEvalIsDraft(true);
  };

  // Surface the indicator banner only when the PI has switched at least
  // one picker *away* from working draft (per plan §D4).
  const draftActive = draftSet != null;
  const draftDriftCount =
    draftActive
      ? (coachIsDraft ? 0 : 1) +
        (fastEvalIsDraft ? 0 : 1) +
        (deepEvalIsDraft ? 0 : 1)
      : 0;

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

        {divergenceSummary && (
          <Alert
            icon={<UpdateIcon fontSize="inherit" />}
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  color="inherit"
                  variant="outlined"
                  onClick={switchAllToLive}
                >
                  Use current main
                </Button>
                <Button
                  size="small"
                  color="inherit"
                  onClick={switchAllToText}
                >
                  Keep editing
                </Button>
              </Stack>
            }
          >
            Prompts have been updated since this session ran (
            {divergenceSummary.fileCount} file
            {divergenceSummary.fileCount === 1 ? "" : "s"},{" "}
            {divergenceSummary.totalCommits} commit
            {divergenceSummary.totalCommits === 1 ? "" : "s"}:{" "}
            {divergenceSummary.fileLabels}). Your feedback may already be
            addressed — try replaying with the current prompts before iterating.
          </Alert>
        )}

        {result && (
          <Alert
            severity="success"
            sx={{ mb: 2 }}
            action={
              <Button
                size="small"
                color="inherit"
                onClick={scrollToResult}
                startIcon={<KeyboardArrowDownIcon />}
              >
                Jump to results
              </Button>
            }
          >
            Replay complete — results are below the prompt editors.
          </Alert>
        )}

        {draftActive && draftDriftCount > 0 && (
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={
              <Button
                size="small"
                color="inherit"
                onClick={switchAllToWorkingDraft}
              >
                Use working draft
              </Button>
            }
          >
            Replaying with custom prompts. Working drafts ({draftDriftCount}{" "}
            picker{draftDriftCount === 1 ? "" : "s"} switched away) are
            available — switch any picker to "Working draft" to test them.
          </Alert>
        )}

        <Stack spacing={2}>
          <AgentPromptControls
            agent="coach"
            selector={coachPrompt}
            onChange={setCoachFromChild}
            originalSha={originalSha}
            draftSet={draftSet}
            isWorkingDraftMode={coachIsDraft}
            onSwitchToWorkingDraft={() => switchOneToWorkingDraft("coach")}
          />
          <AgentPromptControls
            agent="fast_eval"
            selector={fastEvalPrompt}
            onChange={setFastEvalFromChild}
            originalSha={originalSha}
            draftSet={draftSet}
            isWorkingDraftMode={fastEvalIsDraft}
            onSwitchToWorkingDraft={() => switchOneToWorkingDraft("fast_eval")}
          />
          <AgentPromptControls
            agent="deep_eval"
            selector={deepEvalPrompt}
            onChange={setDeepEvalFromChild}
            originalSha={originalSha}
            draftSet={draftSet}
            isWorkingDraftMode={deepEvalIsDraft}
            onSwitchToWorkingDraft={() => switchOneToWorkingDraft("deep_eval")}
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
          <Box ref={resultRef} sx={{ mt: 3, scrollMarginTop: 16 }}>
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

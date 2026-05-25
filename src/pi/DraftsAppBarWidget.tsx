import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { keyframes } from "@mui/system";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_KEYS,
  fetchFeedbackByReviewer,
  fetchHeadOfMainPrompts,
  postSynthesizeDrafts,
  type AgentKey,
  type FeedbackByReviewerItem,
  type SynthesizeDraftsRequest,
} from "./draftsApi";
import {
  applySynthesisResult,
  buildSynthesizeRequest,
  getActiveDraftSet,
  initDraftSet,
  loadAndMigrateDraftSet,
  newFeedbackSinceLastSynth,
  type DraftSet,
} from "./draftsStorage";
import { subscribeFeedbackWrites } from "./feedbackEvents";
import SynthesizePreflightDialog from "./SynthesizePreflightDialog";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
`;

interface DraftsAppBarWidgetProps {
  reviewer: string | null;
  onReviewerMissing: () => void;
}

export default function DraftsAppBarWidget({
  reviewer,
  onReviewerMissing,
}: DraftsAppBarWidgetProps) {
  const [draftSet, setDraftSet] = useState<DraftSet | null>(null);
  const [resetReason, setResetReason] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackByReviewerItem[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [inflight, setInflight] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const [successKind, setSuccessKind] = useState<"changed" | "unchanged">("changed");
  const [concurrentEdit, setConcurrentEdit] = useState(false);

  const reviewerSlugSnapshot = useRef<string | null>(null);

  // Load draft set when reviewer changes.
  useEffect(() => {
    if (!reviewer) {
      setDraftSet(null);
      return;
    }
    if (reviewerSlugSnapshot.current === reviewer) return;
    reviewerSlugSnapshot.current = reviewer;
    const result = loadAndMigrateDraftSet(reviewer);
    setDraftSet(result.set);
    if (result.resetReason) setResetReason(result.resetReason);
  }, [reviewer]);

  const refreshFeedback = useCallback(async () => {
    if (!reviewer) return;
    setFeedbackLoading(true);
    try {
      const r = await fetchFeedbackByReviewer(reviewer);
      setFeedback(r.items);
    } catch (e) {
      // Surface non-fatally; the widget keeps working with the last known set.
      console.warn("fetchFeedbackByReviewer failed:", e);
    } finally {
      setFeedbackLoading(false);
    }
  }, [reviewer]);

  useEffect(() => {
    if (!reviewer) return;
    refreshFeedback();
  }, [reviewer, refreshFeedback]);

  // Subscribe to in-app feedback writes so the counter refreshes immediately.
  useEffect(() => {
    if (!reviewer) return;
    const unsub = subscribeFeedbackWrites(() => {
      refreshFeedback();
    });
    return () => unsub();
  }, [reviewer, refreshFeedback]);

  // Elapsed-seconds ticker while a synthesis call is in flight.
  useEffect(() => {
    if (!inflight) return;
    setElapsedSeconds(0);
    const start = Date.now();
    const t = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [inflight]);

  const computation = useMemo(
    () => newFeedbackSinceLastSynth(draftSet, feedback),
    [draftSet, feedback],
  );

  const editedPromptCount = useMemo(() => {
    if (!draftSet) return 0;
    let n = 0;
    for (const k of AGENT_KEYS) {
      if (draftSet.drafts[k].trim() !== draftSet.originals[k].trim()) n += 1;
    }
    return n;
  }, [draftSet]);

  const startSynthesize = () => {
    if (!reviewer) {
      onReviewerMissing();
      return;
    }
    setError(null);
    setPreflightOpen(true);
  };

  const handleConfirmSynthesize = async (modelOverride: string | null) => {
    if (!reviewer) return;
    setInflight(true);
    setError(null);
    setConcurrentEdit(false);
    try {
      let activeSet = draftSet;
      if (!activeSet) {
        const head = await fetchHeadOfMainPrompts();
        activeSet = initDraftSet({
          reviewer,
          baseline_sha: head.baseline_sha,
          originals: head.originals,
        });
        setDraftSet(activeSet);
      }
      const req: SynthesizeDraftsRequest = buildSynthesizeRequest(
        activeSet,
        computation,
        modelOverride ?? undefined,
      ) as SynthesizeDraftsRequest;
      const includedIds = computation.items.map((it) => it.head_id);
      const response = await postSynthesizeDrafts(req);
      const updated = applySynthesisResult(reviewer, response, includedIds);
      setDraftSet(updated);

      // Detect a concurrent feedback write that landed during synthesis.
      const latestTs = feedback.reduce<string>(
        (acc, f) => (f.ts > acc ? f.ts : acc),
        "",
      );
      if (latestTs && latestTs > response.feedback_snapshot_ts) {
        setConcurrentEdit(true);
      }

      const anyChanged = response.prompts.some((p) => p.new_text != null);
      setSuccessKind(anyChanged ? "changed" : "unchanged");
      setSuccessOpen(true);
      setPreflightOpen(false);
      refreshFeedback();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Synthesis failed";
      setError(msg);
    } finally {
      setInflight(false);
    }
  };

  const onReviewDrafts = () => {
    window.location.assign("/pi/drafts");
  };

  if (!reviewer) {
    return (
      <Tooltip title="Set a reviewer name to enable the drafts feature">
        <Chip
          icon={<AutoAwesomeIcon />}
          label="Drafts: set reviewer first"
          size="small"
          variant="outlined"
          sx={{ color: "inherit", borderColor: "rgba(255,255,255,0.5)" }}
          onClick={onReviewerMissing}
        />
      </Tooltip>
    );
  }

  const hasNew = computation.count > 0;
  const hasFolded = computation.already_folded_in_count > 0;
  const synthLabel = inflight
    ? `Synthesizing… ${elapsedSeconds}s`
    : "Synthesize all my feedback";
  const counterText = draftSet
    ? `Drafts: ${editedPromptCount} prompt${editedPromptCount === 1 ? "" : "s"} edited · ${computation.already_folded_in_count} item${
        computation.already_folded_in_count === 1 ? "" : "s"
      } folded in (${computation.sessions} session${computation.sessions === 1 ? "" : "s"}) · ${computation.count} new since last synth`
    : "Drafts: not started — Synthesize folds all your feedback so far into a working draft set";

  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mr: 1 }}>
        <Typography
          variant="caption"
          sx={{
            color: "rgba(255,255,255,0.85)",
            maxWidth: 460,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {feedbackLoading && !feedback.length ? "Loading drafts state…" : counterText}
        </Typography>
        {hasNew && !inflight && (
          <Chip
            label={`${computation.count} new`}
            color="warning"
            size="small"
            sx={{ animation: `${pulse} 2s ease-in-out infinite` }}
          />
        )}
        {hasFolded && (
          <Chip
            label={`${computation.already_folded_in_count} folded`}
            size="small"
            variant="outlined"
            sx={{ color: "inherit", borderColor: "rgba(255,255,255,0.4)" }}
          />
        )}
        <Button
          color="inherit"
          size="small"
          variant={hasNew || !draftSet ? "contained" : "outlined"}
          onClick={startSynthesize}
          disabled={inflight}
          startIcon={inflight ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon />}
          sx={{
            textTransform: "none",
            color: hasNew || !draftSet ? "primary.main" : "inherit",
            bgcolor: hasNew || !draftSet ? "white" : "transparent",
            borderColor: "rgba(255,255,255,0.5)",
            "&:hover": {
              bgcolor: hasNew || !draftSet ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.1)",
            },
          }}
        >
          {synthLabel}
        </Button>
        <Button
          color="inherit"
          size="small"
          onClick={onReviewDrafts}
          disabled={!draftSet}
          endIcon={<OpenInNewIcon />}
          sx={{ textTransform: "none" }}
        >
          Review drafts
        </Button>
      </Stack>

      {preflightOpen && (
        <SynthesizePreflightDialog
          open={preflightOpen}
          inflight={inflight}
          reviewer={reviewer}
          baselineSha={draftSet?.baseline_sha ?? null}
          computation={computation}
          onClose={() => setPreflightOpen(false)}
          onConfirm={handleConfirmSynthesize}
        />
      )}

      <Snackbar
        open={successOpen}
        autoHideDuration={6000}
        onClose={() => setSuccessOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={successKind === "changed" ? "success" : "info"}
          onClose={() => setSuccessOpen(false)}
          action={
            <Button color="inherit" size="small" onClick={onReviewDrafts}>
              Review drafts
            </Button>
          }
        >
          {successKind === "changed"
            ? "Synthesis complete — open the drafts editor to review the proposed edits."
            : "Synthesis complete; the model judged that no prompt edits are needed for the current feedback."}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!resetReason}
        autoHideDuration={8000}
        onClose={() => setResetReason(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setResetReason(null)}>
          {resetReason}
        </Alert>
      </Snackbar>

      {concurrentEdit && (
        <Snackbar
          open
          autoHideDuration={8000}
          onClose={() => setConcurrentEdit(false)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert severity="info" onClose={() => setConcurrentEdit(false)}>
            A feedback item was added during synthesis and wasn't included.
            Click Synthesize again to fold it in.
          </Alert>
        </Snackbar>
      )}

      {error && (
        <Snackbar
          open
          autoHideDuration={12000}
          onClose={() => setError(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
            {error.includes("did not return a complete tool call") && (
              <Box sx={{ mt: 1 }}>
                <Button size="small" onClick={() => setPreflightOpen(true)}>
                  Try again or switch models
                </Button>
              </Box>
            )}
          </Alert>
        </Snackbar>
      )}
    </>
  );
}

// Re-export so other modules don't have to import the dialog separately.
export { getActiveDraftSet };
export type { AgentKey };

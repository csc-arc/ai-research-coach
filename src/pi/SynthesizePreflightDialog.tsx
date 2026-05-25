import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useMemo, useState } from "react";
import type { NewFeedbackComputation } from "./draftsStorage";

const SYNTHESIS_MODEL_OPTIONS: { id: string; label: string; rate?: { promptUsdPerMtok: number; completionUsdPerMtok: number } }[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "anthropic/claude-sonnet-4.5 (default)",
    rate: { promptUsdPerMtok: 3.0, completionUsdPerMtok: 15.0 },
  },
  {
    id: "anthropic/claude-opus-4-7",
    label: "anthropic/claude-opus-4-7 (deeper reasoning, ~5× cost)",
    rate: { promptUsdPerMtok: 15.0, completionUsdPerMtok: 75.0 },
  },
  {
    id: "openai/gpt-5.5",
    label: "openai/gpt-5.5",
    rate: { promptUsdPerMtok: 5.0, completionUsdPerMtok: 20.0 },
  },
  {
    id: "openai/gpt-5.3-codex",
    label: "openai/gpt-5.3-codex",
    rate: { promptUsdPerMtok: 4.0, completionUsdPerMtok: 16.0 },
  },
];

const ESTIMATED_OUTPUT_TOKENS = 12_000;

interface SessionDescriptor {
  pi: string;
  project: string;
  student: string;
  session_ts: string;
}

export interface SynthesizePreflightDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (modelOverride: string | null) => void;
  reviewer: string;
  baselineSha: string | null;
  computation: NewFeedbackComputation;
  inflight: boolean;
  defaultModel?: string;
}

function uniqueSessions(items: NewFeedbackComputation["items"]): SessionDescriptor[] {
  const seen = new Set<string>();
  const out: SessionDescriptor[] = [];
  for (const it of items) {
    const k = `${it.pi}|${it.project}|${it.student}|${it.session_ts}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      pi: it.pi,
      project: it.project,
      student: it.student,
      session_ts: it.session_ts,
    });
  }
  return out;
}

export default function SynthesizePreflightDialog({
  open,
  onClose,
  onConfirm,
  reviewer,
  baselineSha,
  computation,
  inflight,
  defaultModel,
}: SynthesizePreflightDialogProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // null means "use server default" (ARC_SYNTHESIS_MODEL).
  const [modelOverride, setModelOverride] = useState<string | null>(null);

  const sessions = useMemo(() => uniqueSessions(computation.items), [computation.items]);

  // Rough payload size: every feedback item contributes ~1.5kB on average,
  // plus AGENTS.md (~7kB) + 3 prompts (~30kB total). We don't ship tiktoken
  // in the bundle; this is a 4-chars-per-token heuristic.
  const estimatedInputChars = useMemo(
    () =>
      40_000 +
      computation.items.reduce((acc, it) => {
        const blob = JSON.stringify(it.payload || {});
        return acc + 200 + blob.length;
      }, 0),
    [computation.items],
  );
  const estimatedInputTokens = Math.ceil(estimatedInputChars / 4);

  const resolvedModel = modelOverride ?? defaultModel ?? "anthropic/claude-sonnet-4.5";
  const rate = SYNTHESIS_MODEL_OPTIONS.find((m) => m.id === resolvedModel)?.rate
    ?? SYNTHESIS_MODEL_OPTIONS[0].rate!;
  const promptUsd = (estimatedInputTokens / 1_000_000) * rate.promptUsdPerMtok;
  const completionUsd = (ESTIMATED_OUTPUT_TOKENS / 1_000_000) * rate.completionUsdPerMtok;
  const totalUsd = promptUsd + completionUsd;

  const handleConfirm = () => {
    onConfirm(modelOverride);
  };

  return (
    <Dialog open={open} onClose={inflight ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Synthesize working drafts</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2">
            This sends every piece of feedback you've left across all sessions
            to the synthesis model along with the current drafts and{" "}
            <code>public/AGENTS.md</code>. The model returns updated drafts
            for any prompt where it judges an edit is warranted.
          </Typography>

          <Box>
            <Typography variant="subtitle2">What you'll fold in</Typography>
            <Typography variant="body2">
              <strong>{computation.count}</strong> new feedback item
              {computation.count === 1 ? "" : "s"} since last synth +{" "}
              <strong>{computation.already_folded_in_count}</strong> already
              folded in (treated as resolved by the model).
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Reviewer: {reviewer} · Baseline:{" "}
              {baselineSha ? <code>{baselineSha.slice(0, 7)}</code> : <em>(not pinned)</em>}
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2">
              Sessions ({sessions.length})
            </Typography>
            {sessions.slice(0, 3).map((s) => (
              <Typography key={`${s.pi}/${s.project}/${s.student}/${s.session_ts}`} variant="caption" component="div" sx={{ fontFamily: "monospace" }}>
                {s.student} / {s.project} / {s.session_ts}
              </Typography>
            ))}
            {sessions.length > 3 && (
              <Typography variant="caption" color="text.secondary">
                + {sessions.length - 3} more
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2">Estimated cost</Typography>
            <Typography variant="body2">
              ~{estimatedInputTokens.toLocaleString()} input tokens · ~
              {ESTIMATED_OUTPUT_TOKENS.toLocaleString()} output (rough; ~3
              prompt rewrites × 4k tokens each)
            </Typography>
            <Typography variant="body2">
              ~${totalUsd.toFixed(2)} (rough; ~${promptUsd.toFixed(2)} prompt + ~${completionUsd.toFixed(2)} completion). Rate table is approximate; check{" "}
              <Link href="https://openrouter.ai/models" target="_blank" rel="noreferrer">
                OpenRouter
              </Link>{" "}
              for current pricing.
            </Typography>
          </Box>

          <Box>
            <Button
              size="small"
              onClick={() => setShowAdvanced((v) => !v)}
              startIcon={showAdvanced ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ textTransform: "none" }}
            >
              Advanced
            </Button>
            <Collapse in={showAdvanced}>
              <Box sx={{ mt: 1 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel>Model</InputLabel>
                  <Select
                    label="Model"
                    value={modelOverride ?? "__default__"}
                    onChange={(e) => {
                      const v = String(e.target.value);
                      setModelOverride(v === "__default__" ? null : v);
                    }}
                  >
                    <MenuItem value="__default__">
                      Use server default
                      {defaultModel ? ` (${defaultModel})` : ""}
                    </MenuItem>
                    {SYNTHESIS_MODEL_OPTIONS.map((m) => (
                      <MenuItem key={m.id} value={m.id}>
                        {m.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
                  Override <code>ARC_SYNTHESIS_MODEL</code> for this run only.
                </Typography>
              </Box>
            </Collapse>
          </Box>

          {inflight && (
            <Alert severity="info">
              Synthesizing… large requests can take 30–90 seconds. You can
              keep navigating the dashboard while this runs.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={inflight}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          disabled={inflight}
        >
          Synthesize
        </Button>
      </DialogActions>
    </Dialog>
  );
}

import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import RateReviewIcon from "@mui/icons-material/RateReview";
import ReplayIcon from "@mui/icons-material/Replay";
import UpdateIcon from "@mui/icons-material/Update";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CoachIssueReviewEntry,
  FastEvalArgs,
  FastEvalCoachIssue,
  FastEvalTurnEntry,
  FeedbackBundle,
  IssueFeedbackPost,
  PromptsDivergenceResponse,
  SessionBundle,
  SessionFeedbackPost,
  TranscriptMessage,
  TurnAnnotationEntry,
  TurnFeedbackPost,
  fetchPromptsDivergence,
  postIssueFeedback,
  postSessionFeedback,
  postTurnFeedback,
} from "./piApi";
import { chainsForEntries } from "./feedbackUtils";
import { notifyFeedbackWritten } from "./feedbackEvents";
import { MarkdownContent } from "../react-ai-chat";
import PromptViewer from "./PromptViewer";
import ReplayPanel from "./ReplayPanel";
import {
  CoachIssueReviewWidget,
  SessionFeedbackForm,
  TurnAnnotationWidget,
} from "./FeedbackWidgets";

interface SessionViewerProps {
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  bundle: SessionBundle;
  reviewer: string | null;
  onReviewerMissing: () => void;
  onBundleRefresh: () => void;
}

type Tabish = "summary" | "transcript" | "evaluation" | "metadata";

export default function SessionViewer({
  pi,
  project,
  student,
  sessionTs,
  bundle,
  reviewer,
  onReviewerMissing,
  onBundleRefresh,
}: SessionViewerProps) {
  const [tab, setTab] = useState<Tabish>("summary");

  // Fetch divergence info for the prompts SHA this session was pinned to.
  // Sessions without a pinned SHA (older than Phase A1, or local-fallback
  // hashes) are silently skipped — the chip just won't appear.
  const pinnedSha = bundle.metadata?.prompts_sha ?? null;
  const [divergence, setDivergence] = useState<PromptsDivergenceResponse | null>(null);
  useEffect(() => {
    setDivergence(null);
    if (!pinnedSha) return;
    if (pinnedSha === "unknown" || pinnedSha.startsWith("local:")) return;
    let cancelled = false;
    fetchPromptsDivergence(pinnedSha)
      .then((r) => {
        if (!cancelled) setDivergence(r);
      })
      .catch(() => {
        // Non-fatal — surface nothing rather than a broken UI.
      });
    return () => {
      cancelled = true;
    };
  }, [pinnedSha]);

  const handleSubmit = useCallback(
    async (kind: "session" | "turn" | "issue", body: unknown) => {
      if (!reviewer) {
        onReviewerMissing();
        return;
      }
      try {
        if (kind === "session") {
          await postSessionFeedback(body as SessionFeedbackPost);
        } else if (kind === "turn") {
          await postTurnFeedback(body as TurnFeedbackPost);
        } else {
          await postIssueFeedback(body as IssueFeedbackPost);
        }
        // Tell the drafts widget (and any other in-app subscriber) that a
        // feedback item was written so its counter refreshes immediately.
        notifyFeedbackWritten();
        onBundleRefresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Feedback failed";
        window.alert(`Failed to save feedback: ${msg}`);
      }
    },
    [reviewer, onReviewerMissing, onBundleRefresh],
  );

  return (
    <Box sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ mb: 1, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Box>
          <Typography variant="h6" component="div">
            {student} · {project}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
            {pi} / {sessionTs}
          </Typography>
        </Box>
        <Tooltip title="Refresh bundle">
          <IconButton onClick={onBundleRefresh} size="small">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <SessionStatusChips bundle={bundle} divergence={divergence} />

      <SessionLevelFeedback
        bundle={bundle}
        pi={pi}
        project={project}
        student={student}
        sessionTs={sessionTs}
        reviewer={reviewer}
        onSubmit={(body) => handleSubmit("session", body)}
        onReviewerMissing={onReviewerMissing}
      />

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as Tabish)}
        sx={{ mt: 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab value="summary" label="Summary" />
        <Tab value="transcript" label="Transcript" />
        <Tab value="evaluation" label="Evaluation" />
        <Tab value="metadata" label="Metadata" />
      </Tabs>

      <Box sx={{ flex: 1, overflow: "auto", mt: 2 }}>
        {tab === "summary" && (
          <SummaryTab summary={bundle.summary} cumulative={bundle.cumulative_report} />
        )}
        {tab === "transcript" && (
          <TranscriptTab
            transcript={bundle.transcript}
            fastEvalTurns={bundle.fast_eval_turns}
            feedback={bundle.feedback}
            evaluation={bundle.evaluation}
            pi={pi}
            project={project}
            student={student}
            sessionTs={sessionTs}
            originalSha={bundle.metadata?.prompts_sha ?? null}
            divergence={divergence}
            reviewer={reviewer}
            onTurnSubmit={(body) => handleSubmit("turn", body)}
            onIssueSubmit={(body) => handleSubmit("issue", body)}
            onReviewerMissing={onReviewerMissing}
          />
        )}
        {tab === "evaluation" && <EvaluationTab evaluation={bundle.evaluation} />}
        {tab === "metadata" && <MetadataTab bundle={bundle} />}
      </Box>
    </Box>
  );
}

function SessionStatusChips({
  bundle,
  divergence,
}: {
  bundle: SessionBundle;
  divergence: PromptsDivergenceResponse | null;
}) {
  const md = bundle.metadata;
  const [divergenceOpen, setDivergenceOpen] = useState(false);
  if (!md) return null;
  const chips: { label: string; color?: "default" | "warning" | "error" | "success" }[] = [];
  if (md.status === "recorder_failed") {
    chips.push({ label: "Recorder failed", color: "error" });
  } else if (md.status === "recorded") {
    chips.push({ label: "Recorded", color: "success" });
  } else if (md.status) {
    chips.push({ label: md.status });
  }
  if (md.engagement) chips.push({ label: `engagement: ${md.engagement}` });
  if (typeof md.message_count === "number") {
    chips.push({ label: `${md.message_count} messages` });
  }
  if (typeof md.duration_seconds === "number" && md.duration_seconds > 0) {
    const m = Math.round(md.duration_seconds / 60);
    chips.push({ label: `${m} min` });
  }
  if (md.abrupt) chips.push({ label: "abrupt", color: "warning" });

  const modifiedFiles = useMemo(() => {
    if (!divergence?.comparable || !divergence.any_modified) return [];
    return Object.entries(divergence.prompts).filter(([, v]) => v.modified);
  }, [divergence]);
  const totalCommits = modifiedFiles.reduce(
    (sum, [, v]) => sum + (v.commits?.length ?? 0),
    0,
  );

  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
      {chips.map((c, i) => (
        <Chip key={i} label={c.label} color={c.color ?? "default"} size="small" />
      ))}
      {modifiedFiles.length > 0 && (
        <Tooltip title="Prompt files have been updated on main since this session ran. Click to see what changed.">
          <Chip
            icon={<UpdateIcon />}
            label={`prompts updated since session (${modifiedFiles.length} file${
              modifiedFiles.length === 1 ? "" : "s"
            }, ${totalCommits} commit${totalCommits === 1 ? "" : "s"})`}
            color="warning"
            size="small"
            onClick={() => setDivergenceOpen(true)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>
      )}
      {md.status === "recorder_failed" && md.failure_reason && (
        <Alert severity="warning" sx={{ width: "100%", mt: 1 }}>
          {md.failure_reason}
        </Alert>
      )}
      {divergenceOpen && divergence && (
        <DivergenceDialog
          divergence={divergence}
          onClose={() => setDivergenceOpen(false)}
        />
      )}
    </Stack>
  );
}

function DivergenceDialog({
  divergence,
  onClose,
}: {
  divergence: PromptsDivergenceResponse;
  onClose: () => void;
}) {
  const repoUrl = "https://github.com/csc-arc/ai-research-coach";
  const modifiedFiles = Object.entries(divergence.prompts).filter(
    ([, v]) => v.modified,
  );
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Prompt changes since this session</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Session pinned to{" "}
          <code>{divergence.since_sha.slice(0, 7)}</code>; main is now{" "}
          <code>{divergence.head_sha?.slice(0, 7) ?? "?"}</code>. The PI
          dashboard's drafting flow only edits the coach and eval prompts, so
          recorder-prompt changes aren't tracked here.
        </Typography>
        {modifiedFiles.length === 0 ? (
          <Alert severity="info">
            No coach or eval prompt files have changed since this session ran.
          </Alert>
        ) : (
          <Stack spacing={2}>
            {modifiedFiles.map(([filename, info]) => (
              <Box key={filename}>
                <Typography variant="subtitle2" sx={{ fontFamily: "monospace" }}>
                  public/{filename}
                </Typography>
                <List dense>
                  {(info.commits ?? []).map((c) => (
                    <ListItem key={c.sha} disableGutters sx={{ py: 0 }}>
                      <ListItemText
                        primary={
                          <>
                            <Link
                              href={`${repoUrl}/commit/${c.sha}`}
                              target="_blank"
                              rel="noreferrer"
                              sx={{ fontFamily: "monospace", mr: 1 }}
                            >
                              {c.sha.slice(0, 7)}
                            </Link>
                            {c.commit_subject}
                          </>
                        }
                        secondary={c.committed_at?.slice(0, 10)}
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          href={`${repoUrl}/compare/${divergence.since_sha}...${divergence.head_sha}`}
          target="_blank"
          rel="noreferrer"
        >
          View full diff on GitHub
        </Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function SummaryTab({
  summary,
  cumulative,
}: {
  summary: string | null;
  cumulative: string | null;
}) {
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Session summary
        </Typography>
        <Paper variant="outlined" sx={{ p: 2 }}>
          {summary ? <MarkdownContent content={summary} /> : <em>(no summary)</em>}
        </Paper>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Cumulative report (cross-session)
        </Typography>
        <Paper variant="outlined" sx={{ p: 2 }}>
          {cumulative ? (
            <MarkdownContent content={cumulative} />
          ) : (
            <em>(no cumulative report)</em>
          )}
        </Paper>
      </Box>
    </Stack>
  );
}

function EvaluationTab({ evaluation }: { evaluation: string | null }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      {evaluation ? <MarkdownContent content={evaluation} /> : <em>(no evaluation)</em>}
    </Paper>
  );
}

function MetadataTab({ bundle }: { bundle: SessionBundle }) {
  const md = bundle.metadata;
  const [promptViewer, setPromptViewer] = useState<{ name: string; sha: string } | null>(null);
  if (!md) {
    return <Alert severity="info">Metadata not available for this session.</Alert>;
  }

  const promptVersionsRow = md.prompts_sha ? (
    <TableRow>
      <TableCell>prompts_sha</TableCell>
      <TableCell>
        <Chip
          size="small"
          label={md.prompts_sha === "unknown" ? "unknown" : md.prompts_sha.slice(0, 12)}
          onClick={
            md.prompts_sha === "unknown" || md.prompts_sha.startsWith("local:")
              ? undefined
              : () =>
                  setPromptViewer({
                    name: "instructions-v1",
                    sha: md.prompts_sha as string,
                  })
          }
          sx={{ fontFamily: "monospace", cursor: md.prompts_sha === "unknown" ? "default" : "pointer" }}
        />
        {md.prompts_sha?.startsWith("local:") && (
          <Typography variant="caption" sx={{ ml: 1, color: "text.secondary" }}>
            (fallback content hash; GitHub API unavailable at session start)
          </Typography>
        )}
      </TableCell>
    </TableRow>
  ) : (
    <TableRow>
      <TableCell>prompts_sha</TableCell>
      <TableCell>
        <em>not recorded for this session</em>
      </TableCell>
    </TableRow>
  );

  const renderModelRows = () => {
    if (!md.models) return null;
    return (Object.entries(md.models) as [string, string][]).map(([k, v]) => (
      <TableRow key={`model-${k}`}>
        <TableCell>{`models.${k}`}</TableCell>
        <TableCell sx={{ fontFamily: "monospace" }}>{v}</TableCell>
      </TableRow>
    ));
  };

  const interestingKeys: (keyof typeof md)[] = [
    "student_id",
    "project_id",
    "pi",
    "session_start",
    "session_end",
    "duration_seconds",
    "message_count",
    "abrupt",
    "engagement",
    "coach_issue_count",
    "coach_issue_categories",
    "status",
    "failure_reason",
    "project_description_sha",
  ];

  return (
    <Box>
      <Table size="small">
        <TableBody>
          {interestingKeys.map((k) => {
            if (!(k in md)) return null;
            const value = (md as Record<string, unknown>)[k];
            return (
              <TableRow key={String(k)}>
                <TableCell sx={{ width: 220 }}>{String(k)}</TableCell>
                <TableCell>
                  {value === null || value === undefined ? (
                    <em>—</em>
                  ) : Array.isArray(value) ? (
                    value.length === 0 ? <em>(empty)</em> : value.join(", ")
                  ) : typeof value === "object" ? (
                    <code>{JSON.stringify(value)}</code>
                  ) : (
                    String(value)
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {promptVersionsRow}
          {renderModelRows()}
        </TableBody>
      </Table>
      {promptViewer && (
        <PromptViewer
          open={true}
          promptName={promptViewer.name}
          sha={promptViewer.sha}
          onClose={() => setPromptViewer(null)}
        />
      )}
    </Box>
  );
}

interface TranscriptTabProps {
  transcript: TranscriptMessage[];
  fastEvalTurns: FastEvalTurnEntry[] | null;
  feedback: FeedbackBundle | null;
  evaluation: string | null;
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  originalSha: string | null;
  divergence: PromptsDivergenceResponse | null;
  reviewer: string | null;
  onTurnSubmit: (body: TurnFeedbackPost) => void;
  onIssueSubmit: (body: IssueFeedbackPost) => void;
  onReviewerMissing: () => void;
}

function TranscriptTab({
  transcript,
  fastEvalTurns,
  feedback,
  evaluation,
  pi,
  project,
  student,
  sessionTs,
  originalSha,
  divergence,
  reviewer,
  onTurnSubmit,
  onIssueSubmit,
  onReviewerMissing,
}: TranscriptTabProps) {
  const fastEvalByUserTurn = useMemo(() => {
    const m = new Map<number, FastEvalArgs>();
    if (fastEvalTurns) {
      for (const e of fastEvalTurns) {
        if (typeof e.turn === "number" && e.fast_eval) m.set(e.turn, e.fast_eval);
      }
    }
    return m;
  }, [fastEvalTurns]);

  // Replay state — opened from a specific user turn.
  const [replayState, setReplayState] = useState<{ turn: number } | null>(null);

  // Walk the transcript, counting user turns 1-indexed so we can correlate
  // each user message with the fast-eval entry that was emitted afterward.
  let userTurn = 0;
  return (
    <Stack spacing={2}>
      {transcript.length === 0 && (
        <Alert severity="info">No transcript was recorded for this session.</Alert>
      )}
      {transcript.map((msg, i) => {
        const isUser = msg.role === "user";
        const isAssistant = msg.role === "assistant";
        if (isUser) userTurn += 1;
        // A "turn" is (user input → coach response). We label both rows with
        // the same turn number so the pairing is visually obvious. The
        // opening greeting (assistant message before any user input) has no
        // turn number — it isn't really a turn.
        const turnIndex = userTurn > 0 ? userTurn : null;
        const fastEvalForCoachAfter = isAssistant
          ? fastEvalByUserTurn.get(userTurn)
          : undefined;
        // Annotate / replay controls live on the assistant row, since
        // they're about the coach's response to the user's input.
        const showCoachControls = isAssistant && turnIndex != null;

        return (
          <Box key={i}>
            {isAssistant && fastEvalForCoachAfter && (
              <FastEvalInlineBlock
                args={fastEvalForCoachAfter}
                feedback={feedback}
                turn={userTurn}
                pi={pi}
                project={project}
                student={student}
                sessionTs={sessionTs}
                reviewer={reviewer}
                onIssueSubmit={onIssueSubmit}
                onReviewerMissing={onReviewerMissing}
              />
            )}
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                bgcolor: isUser ? "grey.50" : "white",
              }}
            >
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase" }}>
                  {msg.role}
                  {turnIndex != null ? ` · turn ${turnIndex}` : ""}
                  {msg.timestamp ? ` · ${msg.timestamp}` : ""}
                </Typography>
                {showCoachControls && (
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="Replay this coach response">
                      <IconButton
                        size="small"
                        onClick={() => setReplayState({ turn: userTurn })}
                      >
                        <ReplayIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                )}
              </Box>
              <MarkdownContent content={typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)} />

              {/* Turn-level annotation widget anchored on the coach response. */}
              {showCoachControls && (
                <TurnAnnotationWidget
                  pi={pi}
                  project={project}
                  student={student}
                  sessionTs={sessionTs}
                  turn={userTurn}
                  reviewer={reviewer}
                  onReviewerMissing={onReviewerMissing}
                  existing={(feedback?.turn_annotations || []).filter((t) => t.turn === userTurn)}
                  onSubmit={onTurnSubmit}
                />
              )}
            </Paper>
          </Box>
        );
      })}

      {replayState && (
        <ReplayPanel
          open={true}
          onClose={() => setReplayState(null)}
          pi={pi}
          project={project}
          student={student}
          sessionTs={sessionTs}
          turn={replayState.turn}
          originalSha={originalSha}
          divergence={divergence}
          reviewer={reviewer}
          recordedFastEvalForTurn={
            (() => {
              const args = fastEvalByUserTurn.get(replayState.turn);
              return args ? renderFastEvalSummary(args) : null;
            })()
          }
          recordedDeepEval={evaluation}
        />
      )}
    </Stack>
  );
}

function renderFastEvalSummary(args: FastEvalArgs): string {
  // Render a small markdown blob of the fast-eval args, used to show the
  // originally-recorded fast-eval next to a replay's freshly-computed one.
  const parts: string[] = [];
  if (args.mode_effectiveness) {
    parts.push(`**Mode effectiveness:** ${args.mode_effectiveness}`);
  }
  if (args.suggested_next_move) {
    parts.push(`**Suggested next move:** ${args.suggested_next_move}`);
  }
  if (args.coach_issues && args.coach_issues.length) {
    parts.push("**Coach issues:**");
    for (const issue of args.coach_issues) {
      parts.push(`- _${issue.category}_ — ${issue.observation}`);
    }
  }
  if (args.student_red_flags && args.student_red_flags.length) {
    parts.push("**Student red flags:**");
    for (const flag of args.student_red_flags) {
      parts.push(`- _${flag.category}_ — ${flag.observation}`);
    }
  }
  if (args.open_threads && args.open_threads.length) {
    parts.push(`**Open threads:** ${args.open_threads.join(", ")}`);
  }
  return parts.join("\n\n");
}

interface FastEvalInlineBlockProps {
  args: FastEvalArgs;
  feedback: FeedbackBundle | null;
  turn: number;
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  reviewer: string | null;
  onIssueSubmit: (body: IssueFeedbackPost) => void;
  onReviewerMissing: () => void;
}

function FastEvalInlineBlock({
  args,
  feedback,
  turn,
  pi,
  project,
  student,
  sessionTs,
  reviewer,
  onIssueSubmit,
  onReviewerMissing,
}: FastEvalInlineBlockProps) {
  const [open, setOpen] = useState(false);
  const issueCount = args.coach_issues?.length || 0;
  const flagCount = args.student_red_flags?.length || 0;
  const issueReviewsForTurn = (feedback?.coach_issue_reviews || []).filter(
    (r) => r.turn === turn,
  );

  if (issueCount === 0 && flagCount === 0 && !args.suggested_next_move) {
    return null;
  }

  return (
    <Box sx={{ mb: 1 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          fontSize: 12,
          color: "text.secondary",
          cursor: "pointer",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <Typography variant="caption" sx={{ flex: 1 }}>
          fast-eval context for turn {turn} —{" "}
          {issueCount} coach issue{issueCount === 1 ? "" : "s"},{" "}
          {flagCount} student red flag{flagCount === 1 ? "" : "s"}
          {args.mode_effectiveness && `, mode: ${args.mode_effectiveness}`}
        </Typography>
        <Button size="small" variant="text" sx={{ minWidth: 80 }}>
          {open ? "Hide" : "Show"}
        </Button>
      </Box>
      {open && (
        <Paper
          variant="outlined"
          sx={{ p: 1.5, mt: 0.5, bgcolor: "grey.50" }}
        >
          {args.suggested_next_move && (
            <Box sx={{ mb: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                Suggested next move:
              </Typography>{" "}
              <Typography variant="caption">{args.suggested_next_move}</Typography>
            </Box>
          )}
          {(args.coach_issues || []).map((issue, i) => (
            <CoachIssueInline
              key={i}
              issue={issue}
              turn={turn}
              pi={pi}
              project={project}
              student={student}
              sessionTs={sessionTs}
              reviewer={reviewer}
              existing={issueReviewsForTurn.filter(
                (r) => r.issue_category === issue.category,
              )}
              onSubmit={onIssueSubmit}
              onReviewerMissing={onReviewerMissing}
            />
          ))}
          {(args.student_red_flags || []).map((flag, i) => (
            <Box key={i} sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                Student red flag — {flag.category}:
              </Typography>{" "}
              <Typography variant="caption">{flag.observation}</Typography>
              {flag.suggested_response && (
                <Typography variant="caption" component="div" sx={{ ml: 2, fontStyle: "italic" }}>
                  Response: {flag.suggested_response}
                </Typography>
              )}
            </Box>
          ))}
          {args.open_threads && args.open_threads.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                Open threads:
              </Typography>{" "}
              <Typography variant="caption">{args.open_threads.join(" · ")}</Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
}

interface CoachIssueInlineProps {
  issue: FastEvalCoachIssue;
  turn: number;
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  reviewer: string | null;
  existing: CoachIssueReviewEntry[];
  onSubmit: (body: IssueFeedbackPost) => void;
  onReviewerMissing: () => void;
}

function CoachIssueInline({
  issue,
  turn,
  pi,
  project,
  student,
  sessionTs,
  reviewer,
  existing,
  onSubmit,
  onReviewerMissing,
}: CoachIssueInlineProps) {
  return (
    <Box sx={{ mt: 1, p: 1, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "white" }}>
      <Typography variant="caption" sx={{ fontWeight: 600, color: "warning.dark" }}>
        Coach issue — {issue.category}
      </Typography>
      <Typography variant="caption" component="div">
        {issue.observation}
      </Typography>
      {issue.suggested_correction && (
        <Typography variant="caption" component="div" sx={{ fontStyle: "italic", ml: 2, mt: 0.25 }}>
          Correction: {issue.suggested_correction}
        </Typography>
      )}
      <Box sx={{ mt: 0.5 }}>
        <CoachIssueReviewWidget
          pi={pi}
          project={project}
          student={student}
          sessionTs={sessionTs}
          turn={turn}
          issueCategory={issue.category}
          reviewer={reviewer}
          onReviewerMissing={onReviewerMissing}
          existing={existing}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}

interface SessionLevelFeedbackProps {
  bundle: SessionBundle;
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  reviewer: string | null;
  onSubmit: (body: SessionFeedbackPost) => void;
  onReviewerMissing: () => void;
}

function SessionLevelFeedback({
  bundle,
  pi,
  project,
  student,
  sessionTs,
  reviewer,
  onSubmit,
  onReviewerMissing,
}: SessionLevelFeedbackProps) {
  const [open, setOpen] = useState(false);
  const chains = chainsForEntries(bundle.feedback?.session_ratings);
  return (
    <Box sx={{ mb: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<RateReviewIcon fontSize="small" />}
          onClick={() => setOpen(true)}
        >
          Leave session feedback
        </Button>
        {chains.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {chains.length} review{chains.length === 1 ? "" : "s"} on file
          </Typography>
        )}
      </Stack>
      {chains.length > 0 && (
        <Paper variant="outlined" sx={{ p: 1, mb: 1 }}>
          {chains.map(({ head, history }) => (
            <Box key={head.id} sx={{ mb: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={head.rating} color={head.rating === "great" ? "success" : head.rating === "poor" ? "error" : "default"} />
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 600,
                    textDecoration: head.retracted ? "line-through" : "none",
                  }}
                >
                  {head.reviewer}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {head.ts.slice(0, 19).replace("T", " ")}
                </Typography>
                {history.length > 1 && (
                  <Chip size="small" variant="outlined" label="(revised)" />
                )}
              </Stack>
              {head.note && (
                <Typography variant="body2" sx={{ ml: 5, mt: 0.5 }}>
                  {head.note}
                </Typography>
              )}
            </Box>
          ))}
        </Paper>
      )}
      {open && (
        <SessionFeedbackForm
          pi={pi}
          project={project}
          student={student}
          sessionTs={sessionTs}
          reviewer={reviewer}
          onClose={() => setOpen(false)}
          onSubmit={(body: SessionFeedbackPost) => {
            onSubmit(body);
            setOpen(false);
          }}
          onReviewerMissing={onReviewerMissing}
        />
      )}
      <Divider />
    </Box>
  );
}

// Re-export for the other modules. Keeps the file split clean.
export type { TurnAnnotationEntry, CoachIssueReviewEntry };

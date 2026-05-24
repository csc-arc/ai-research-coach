import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import HistoryIcon from "@mui/icons-material/History";
import { useState } from "react";
import {
  CoachIssueReviewEntry,
  IssueFeedbackPost,
  SessionFeedbackPost,
  TurnAnnotationEntry,
  TurnFeedbackPost,
} from "./piApi";
import { chainsForEntries } from "./feedbackUtils";

// ---------------------------------------------------------------------------
// Session-level form
// ---------------------------------------------------------------------------

interface SessionFeedbackFormProps {
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  reviewer: string | null;
  onClose: () => void;
  onSubmit: (body: SessionFeedbackPost) => void;
  onReviewerMissing: () => void;
  /** When set, the form is in "edit" mode and the new entry is a revision. */
  supersedes?: { id: string; rating: string; note: string };
}

export function SessionFeedbackForm({
  pi,
  project,
  student,
  sessionTs,
  reviewer,
  onClose,
  onSubmit,
  onReviewerMissing,
  supersedes,
}: SessionFeedbackFormProps) {
  const [rating, setRating] = useState<"great" | "ok" | "poor">(
    (supersedes?.rating as "great" | "ok" | "poor") || "ok",
  );
  const [note, setNote] = useState(supersedes?.note ?? "");

  const handleSubmit = () => {
    if (!reviewer) {
      onReviewerMissing();
      return;
    }
    onSubmit({
      pi,
      project,
      student,
      session_ts: sessionTs,
      reviewer,
      rating,
      note,
      supersedes: supersedes?.id,
    });
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{supersedes ? "Revise session feedback" : "Leave session feedback"}</DialogTitle>
      <DialogContent>
        {!reviewer && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            Set your reviewer name first (top-right).
          </Alert>
        )}
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Box>
            <Typography variant="caption">Rating</Typography>
            <ButtonGroup fullWidth size="small" sx={{ mt: 0.5 }}>
              {(["great", "ok", "poor"] as const).map((r) => (
                <Button
                  key={r}
                  variant={rating === r ? "contained" : "outlined"}
                  onClick={() => setRating(r)}
                >
                  {r}
                </Button>
              ))}
            </ButtonGroup>
          </Box>
          <TextField
            label="Note (markdown)"
            multiline
            minRows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!reviewer} onClick={handleSubmit}>
          {supersedes ? "Save revision" : "Submit"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Turn-level annotation widget
// ---------------------------------------------------------------------------

interface TurnAnnotationWidgetProps {
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  turn: number;
  reviewer: string | null;
  onReviewerMissing: () => void;
  existing: TurnAnnotationEntry[];
  onSubmit: (body: TurnFeedbackPost) => void;
}

export function TurnAnnotationWidget({
  pi,
  project,
  student,
  sessionTs,
  turn,
  reviewer,
  onReviewerMissing,
  existing,
  onSubmit,
}: TurnAnnotationWidgetProps) {
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TurnAnnotationEntry | null>(null);
  const [showHistory, setShowHistory] = useState<Set<string>>(new Set());
  const chains = chainsForEntries(existing);

  return (
    <Box sx={{ mt: 1 }}>
      {chains.length > 0 && (
        <Stack spacing={0.5} sx={{ mb: 0.5 }}>
          {chains.map(({ head, history }) => (
            <Box
              key={head.id}
              sx={{
                fontSize: 12,
                p: 0.5,
                borderLeft: 3,
                borderColor: head.tag === "coach_problem" ? "warning.main" : "info.main",
                pl: 1,
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={head.tag} variant="outlined" />
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 600,
                    textDecoration: head.retracted ? "line-through" : "none",
                  }}
                >
                  {head.reviewer}
                </Typography>
                {history.length > 1 && (
                  <Chip size="small" label={`(revised, ${history.length})`} variant="outlined" />
                )}
                {reviewer === head.reviewer && !head.retracted && (
                  <>
                    <Tooltip title="Edit (creates a new entry that supersedes this one)">
                      <IconButton size="small" onClick={() => setEditTarget(head)}>
                        <EditIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Retract this entry">
                      <IconButton
                        size="small"
                        onClick={() => {
                          if (!reviewer) {
                            onReviewerMissing();
                            return;
                          }
                          if (
                            window.confirm(
                              "Retract this annotation? This appends a new retraction entry.",
                            )
                          ) {
                            onSubmit({
                              pi,
                              project,
                              student,
                              session_ts: sessionTs,
                              reviewer,
                              turn,
                              tag: head.tag,
                              note: "",
                              supersedes: head.id,
                              retracted: true,
                            });
                          }
                        }}
                      >
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </>
                )}
                {history.length > 1 && (
                  <Tooltip title="See revision history">
                    <IconButton
                      size="small"
                      onClick={() => {
                        const next = new Set(showHistory);
                        if (next.has(head.id)) next.delete(head.id);
                        else next.add(head.id);
                        setShowHistory(next);
                      }}
                    >
                      <HistoryIcon fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
              {head.note && (
                <Typography variant="caption" component="div" sx={{ ml: 2 }}>
                  {head.note}
                </Typography>
              )}
              {showHistory.has(head.id) && history.length > 1 && (
                <Box sx={{ ml: 2, mt: 0.5, opacity: 0.7 }}>
                  {history.slice(0, -1).map((h) => (
                    <Typography variant="caption" component="div" key={h.id}>
                      {h.ts.slice(0, 19)} — {h.note || "(no note)"}
                    </Typography>
                  ))}
                </Box>
              )}
            </Box>
          ))}
        </Stack>
      )}
      <Button
        size="small"
        variant="text"
        onClick={() => setOpen(true)}
        sx={{ textTransform: "none", py: 0 }}
      >
        + annotate this turn
      </Button>
      {open && (
        <TurnAnnotationForm
          pi={pi}
          project={project}
          student={student}
          sessionTs={sessionTs}
          turn={turn}
          reviewer={reviewer}
          onClose={() => setOpen(false)}
          onReviewerMissing={onReviewerMissing}
          onSubmit={(body) => {
            onSubmit(body);
            setOpen(false);
          }}
        />
      )}
      {editTarget && (
        <TurnAnnotationForm
          pi={pi}
          project={project}
          student={student}
          sessionTs={sessionTs}
          turn={turn}
          reviewer={reviewer}
          onClose={() => setEditTarget(null)}
          onReviewerMissing={onReviewerMissing}
          onSubmit={(body) => {
            onSubmit(body);
            setEditTarget(null);
          }}
          supersedes={editTarget}
        />
      )}
    </Box>
  );
}

interface TurnAnnotationFormProps {
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  turn: number;
  reviewer: string | null;
  onClose: () => void;
  onReviewerMissing: () => void;
  onSubmit: (body: TurnFeedbackPost) => void;
  supersedes?: TurnAnnotationEntry;
}

function TurnAnnotationForm({
  pi,
  project,
  student,
  sessionTs,
  turn,
  reviewer,
  onClose,
  onReviewerMissing,
  onSubmit,
  supersedes,
}: TurnAnnotationFormProps) {
  const [tag, setTag] = useState<TurnAnnotationEntry["tag"]>(
    supersedes?.tag ?? "note",
  );
  const [note, setNote] = useState(supersedes?.note ?? "");
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {supersedes ? "Revise annotation" : "Annotate"} — turn {turn}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Select
            size="small"
            value={tag}
            onChange={(e) => setTag(e.target.value as TurnAnnotationEntry["tag"])}
          >
            <MenuItem value="note">note</MenuItem>
            <MenuItem value="coach_good">coach_good</MenuItem>
            <MenuItem value="coach_problem">coach_problem</MenuItem>
            <MenuItem value="student_issue">student_issue</MenuItem>
          </Select>
          <TextField
            label="Note (markdown)"
            multiline
            minRows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!reviewer}
          onClick={() => {
            if (!reviewer) {
              onReviewerMissing();
              return;
            }
            onSubmit({
              pi,
              project,
              student,
              session_ts: sessionTs,
              reviewer,
              turn,
              tag,
              note,
              supersedes: supersedes?.id,
            });
          }}
        >
          {supersedes ? "Save revision" : "Submit"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Coach-issue review widget (inline next to the fast-eval flag)
// ---------------------------------------------------------------------------

interface CoachIssueReviewWidgetProps {
  pi: string;
  project: string;
  student: string;
  sessionTs: string;
  turn: number;
  issueCategory: string;
  reviewer: string | null;
  onReviewerMissing: () => void;
  existing: CoachIssueReviewEntry[];
  onSubmit: (body: IssueFeedbackPost) => void;
}

export function CoachIssueReviewWidget({
  pi,
  project,
  student,
  sessionTs,
  turn,
  issueCategory,
  reviewer,
  onReviewerMissing,
  existing,
  onSubmit,
}: CoachIssueReviewWidgetProps) {
  const chains = chainsForEntries(existing);
  const [noteOpen, setNoteOpen] = useState(false);
  const [pendingVerdict, setPendingVerdict] = useState<"agree" | "disagree" | "partial" | null>(null);
  const [note, setNote] = useState("");

  const submit = (verdict: "agree" | "disagree" | "partial", noteText: string) => {
    if (!reviewer) {
      onReviewerMissing();
      return;
    }
    onSubmit({
      pi,
      project,
      student,
      session_ts: sessionTs,
      reviewer,
      turn,
      issue_category: issueCategory,
      verdict,
      note: noteText,
    });
  };

  return (
    <Box>
      <Stack direction="row" spacing={0.5} alignItems="center">
        {(["agree", "disagree", "partial"] as const).map((v) => (
          <Button
            key={v}
            size="small"
            variant="outlined"
            onClick={() => {
              setPendingVerdict(v);
              setNote("");
              setNoteOpen(true);
            }}
            sx={{ textTransform: "none", py: 0, fontSize: 11 }}
          >
            {v}
          </Button>
        ))}
        {chains.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {chains.length} review{chains.length === 1 ? "" : "s"}
          </Typography>
        )}
      </Stack>
      {chains.length > 0 && (
        <Stack spacing={0.25} sx={{ mt: 0.5 }}>
          {chains.map(({ head, history }) => (
            <Box key={head.id} sx={{ fontSize: 11 }}>
              <Chip size="small" label={head.verdict} sx={{ mr: 0.5, fontSize: 10, height: 18 }} />
              <strong>{head.reviewer}</strong>
              {head.note && <span> — {head.note}</span>}
              {history.length > 1 && <span> (revised)</span>}
              {head.retracted && <span> [retracted]</span>}
            </Box>
          ))}
        </Stack>
      )}

      {noteOpen && pendingVerdict && (
        <Dialog open onClose={() => setNoteOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>
            Verdict: {pendingVerdict} — {issueCategory}
          </DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              label="Note (optional)"
              multiline
              minRows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => {
                submit(pendingVerdict, note);
                setNoteOpen(false);
              }}
            >
              Submit
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}

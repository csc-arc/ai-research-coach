import { Alert, Box, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Button, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { fetchPromptAtSha, PromptContentResponse } from "./piApi";

interface PromptViewerProps {
  open: boolean;
  promptName: string;
  sha: string;
  title?: string;
  onClose: () => void;
}

export default function PromptViewer({
  open,
  promptName,
  sha,
  title,
  onClose,
}: PromptViewerProps) {
  const [content, setContent] = useState<PromptContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setContent(null);
    setError(null);
    setLoading(true);
    fetchPromptAtSha(promptName, sha)
      .then(setContent)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load prompt"))
      .finally(() => setLoading(false));
  }, [open, promptName, sha]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {title ?? `Prompt: ${promptName}`}
        <Typography
          variant="caption"
          component="div"
          sx={{ color: "text.secondary", fontFamily: "monospace", mt: 0.25 }}
        >
          {sha === "live" ? "head of main" : sha}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ p: 4, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : content ? (
          <Box
            component="pre"
            sx={{
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              m: 0,
            }}
          >
            {content.content}
          </Box>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

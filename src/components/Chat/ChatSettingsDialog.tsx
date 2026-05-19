import { FunctionComponent, useEffect, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Alert,
  Divider,
  Chip,
} from "@mui/material";
import { DEFAULT_MODEL } from "../../chat/availableModels";
import { ID_REGEX, isValidId } from "../../studentProject";

interface ChatSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  studentId: string | null;
  projectId: string | null;
  onStudentProjectChange: (next: { studentId: string | null; projectId: string | null }) => void;
}

const ChatSettingsDialog: FunctionComponent<ChatSettingsDialogProps> = ({
  open,
  onClose,
  studentId,
  projectId,
  onStudentProjectChange,
}) => {
  const [studentDraft, setStudentDraft] = useState<string>(studentId ?? "");
  const [projectDraft, setProjectDraft] = useState<string>(projectId ?? "");

  useEffect(() => {
    if (open) {
      setStudentDraft(studentId ?? "");
      setProjectDraft(projectId ?? "");
    }
  }, [open, studentId, projectId]);

  const studentDraftValid = studentDraft === "" || isValidId(studentDraft);
  const projectDraftValid = projectDraft === "" || isValidId(projectDraft);
  const studentDirty = studentDraft !== (studentId ?? "");
  const projectDirty = projectDraft !== (projectId ?? "");
  const idsDirty = studentDirty || projectDirty;
  const idsValid = studentDraftValid && projectDraftValid;
  const idsBothPresent = isValidId(studentDraft) && isValidId(projectDraft);

  const handleSaveIds = () => {
    if (!idsValid) return;
    onStudentProjectChange({
      studentId: studentDraft.trim() || null,
      projectId: projectDraft.trim() || null,
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3, pt: 1 }}>
          {/* Student / Project Identity */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Student &amp; Project
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              These ids scope your workspace on the server. Required before any
              script can run. Allowed characters: letters, digits, dash,
              underscore (1&ndash;64 chars).
            </Typography>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <TextField
                fullWidth
                size="small"
                label="Student ID"
                value={studentDraft}
                onChange={(e) => setStudentDraft(e.target.value)}
                placeholder="e.g. jane-doe-2026"
                error={!studentDraftValid}
                helperText={
                  !studentDraftValid
                    ? `Must match ${ID_REGEX.source}`
                    : " "
                }
                inputProps={{ autoCapitalize: "none", spellCheck: false }}
              />
              <TextField
                fullWidth
                size="small"
                label="Project ID"
                value={projectDraft}
                onChange={(e) => setProjectDraft(e.target.value)}
                placeholder="e.g. cell-classification-pilot"
                error={!projectDraftValid}
                helperText={
                  !projectDraftValid
                    ? `Must match ${ID_REGEX.source}`
                    : " "
                }
                inputProps={{ autoCapitalize: "none", spellCheck: false }}
              />
              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleSaveIds}
                  disabled={!idsDirty || !idsValid}
                >
                  Save IDs
                </Button>
              </Box>
              {!idsBothPresent && (
                <Alert severity="warning">
                  Both Student ID and Project ID must be set before scripts can run.
                </Alert>
              )}
            </Box>
          </Box>

          <Divider />

          {/* Model (static — locked to claude-4.5-sonnet) */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              AI Model
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Chip
                label={DEFAULT_MODEL.split("/")[1]}
                size="small"
                color="primary"
                variant="outlined"
              />
              <Typography variant="body2" color="text.secondary">
                API key managed server-side
              </Typography>
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default ChatSettingsDialog;

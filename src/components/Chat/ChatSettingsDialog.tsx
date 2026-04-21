import { FunctionComponent, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Box,
  Alert,
  IconButton,
  InputAdornment,
  Divider,
} from "@mui/material";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { AVAILABLE_MODELS, CHEAP_MODELS } from "../../chat/availableModels";
import {
  getStoredOpenRouterApiKey,
  setStoredOpenRouterApiKey,
  clearStoredOpenRouterApiKey,
  maskApiKey,
} from "../../chat/apiKeyStorage";
import { ID_REGEX, isValidId } from "../../studentProject";

interface ChatSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  currentModel: string;
  onModelChange: (model: string) => void;
  studentId: string | null;
  projectId: string | null;
  onStudentProjectChange: (next: { studentId: string | null; projectId: string | null }) => void;
}

const ChatSettingsDialog: FunctionComponent<ChatSettingsDialogProps> = ({
  open,
  onClose,
  currentModel,
  onModelChange,
  studentId,
  projectId,
  onStudentProjectChange,
}) => {
  const [apiKey, setApiKey] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // Local form state for the student/project fields, seeded from props
  // each time the dialog opens (so a Cancel-equivalent close just leaves
  // the persisted values untouched).
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

  // Check for stored key on each render when open (derived state)
  const hasStoredKey = useMemo(() => {
    if (!open) return false;
    void refreshKey;
    return !!getStoredOpenRouterApiKey();
  }, [open, refreshKey]);

  const handleSaveApiKey = () => {
    if (apiKey.trim()) {
      setStoredOpenRouterApiKey(apiKey.trim());
      setApiKey("");
      setRefreshKey((k) => k + 1);
    }
  };

  const handleClearApiKey = () => {
    clearStoredOpenRouterApiKey();
    setApiKey("");
    setRefreshKey((k) => k + 1);
  };

  const handleSaveIds = () => {
    if (!idsValid) return;
    onStudentProjectChange({
      studentId: studentDraft.trim() || null,
      projectId: projectDraft.trim() || null,
    });
  };

  const requiresApiKey = !CHEAP_MODELS.includes(currentModel);

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

          {/* Model Selection */}
          <FormControl fullWidth>
            <InputLabel id="model-select-label">AI Model</InputLabel>
            <Select
              labelId="model-select-label"
              value={currentModel}
              label="AI Model"
              onChange={(e) => onModelChange(e.target.value)}
            >
              {AVAILABLE_MODELS.map((model) => (
                <MenuItem key={model.model} value={model.model}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                      alignItems: "center",
                    }}
                  >
                    <span>{model.label}</span>
                    <Typography
                      variant="caption"
                      sx={{
                        ml: 2,
                        color: CHEAP_MODELS.includes(model.model)
                          ? "success.main"
                          : "warning.main",
                      }}
                    >
                      {CHEAP_MODELS.includes(model.model)
                        ? "Free"
                        : `$${model.cost.prompt}/$${model.cost.completion} per 1M tokens`}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Model Info */}
          <Alert severity={requiresApiKey ? "warning" : "info"}>
            {requiresApiKey ? (
              <>
                <strong>{currentModel.split("/")[1]}</strong> requires an
                OpenRouter API key. Get one at{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  openrouter.ai/keys
                </a>
              </>
            ) : (
              <>
                <strong>{currentModel.split("/")[1]}</strong> is a free model
                and doesn't require your own API key.
              </>
            )}
          </Alert>

          {/* API Key Section */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              OpenRouter API Key (Optional)
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Required only for premium models. Your key is stored locally in
              your browser.
            </Typography>

            {hasStoredKey ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <TextField
                  fullWidth
                  value={maskApiKey(getStoredOpenRouterApiKey() || "")}
                  disabled
                  size="small"
                  label="Stored API Key"
                />
                <Button
                  variant="outlined"
                  color="error"
                  onClick={handleClearApiKey}
                  size="small"
                >
                  Remove
                </Button>
              </Box>
            ) : (
              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <TextField
                  fullWidth
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-or-..."
                  size="small"
                  label="Enter API Key"
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => setShowApiKey(!showApiKey)}
                          edge="end"
                          size="small"
                        >
                          {showApiKey ? (
                            <VisibilityOffIcon />
                          ) : (
                            <VisibilityIcon />
                          )}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
                <Button
                  variant="contained"
                  onClick={handleSaveApiKey}
                  disabled={!apiKey.trim()}
                  size="small"
                >
                  Save
                </Button>
              </Box>
            )}
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

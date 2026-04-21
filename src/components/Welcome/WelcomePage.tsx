import { useMemo, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Paper,
  Divider,
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  IconButton,
  Collapse,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { ID_REGEX, isValidId, useStudentProject } from '../../studentProject';

export interface WelcomeIdentity {
  studentId: string;
  projectId: string;
}

interface WelcomePageProps {
  onInstructions: (instructionsUrl: string, identity: WelcomeIdentity) => void;
}

// Helper function to get all local instructions from localStorage
const getLocalInstructionsList = (): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('local_instructions_')) {
      const name = key.substring('local_instructions_'.length);
      keys.push(name);
    }
  }
  return keys.sort();
};

export function WelcomePage({ onInstructions }: WelcomePageProps) {
  const { studentId, projectId, update: updateStudentProject } = useStudentProject();

  const [studentIdInput, setStudentIdInput] = useState(studentId ?? '');
  const [projectIdInput, setProjectIdInput] = useState(projectId ?? '');
  const [instructionsUrl, setInstructionsUrl] = useState('');
  const [localInstructionsName, setLocalInstructionsName] = useState('');
  const [existingLocalInstructions, setExistingLocalInstructions] = useState<string[]>(() => getLocalInstructionsList());
  const [showExisting, setShowExisting] = useState(() => getLocalInstructionsList().length > 0);

  const trimmedStudentId = studentIdInput.trim();
  const trimmedProjectId = projectIdInput.trim();

  const studentIdError = useMemo(() => {
    if (!trimmedStudentId) return null;
    return isValidId(trimmedStudentId) ? null : 'Use letters, digits, "_" or "-" (max 64 chars).';
  }, [trimmedStudentId]);

  const projectIdError = useMemo(() => {
    if (!trimmedProjectId) return null;
    return isValidId(trimmedProjectId) ? null : 'Use letters, digits, "_" or "-" (max 64 chars).';
  }, [trimmedProjectId]);

  const identityValid = isValidId(trimmedStudentId) && isValidId(trimmedProjectId);

  const persistAndContinue = (instructionsRef: string) => {
    if (!identityValid) return;
    const identity: WelcomeIdentity = {
      studentId: trimmedStudentId,
      projectId: trimmedProjectId,
    };
    // Persist for non-React consumers (e.g. runScript) before navigation.
    updateStudentProject({ studentId: identity.studentId, projectId: identity.projectId });
    onInstructions(instructionsRef, identity);
  };

  const handleSubmitUrl = () => {
    const url = instructionsUrl.trim();
    if (!url || !identityValid) return;
    persistAndContinue(url);
  };

  const handleSubmitLocal = () => {
    const name = localInstructionsName.trim();
    if (!name || !identityValid) return;
    persistAndContinue(`local:${name}`);
  };

  const handleSelectExisting = (name: string) => {
    if (!identityValid) return;
    persistAndContinue(`local:${name}`);
  };

  const handleDeleteLocal = (name: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (window.confirm(`Are you sure you want to delete the local instructions "${name}"?`)) {
      const localKey = `local_instructions_${name}`;
      localStorage.removeItem(localKey);
      const updated = getLocalInstructionsList();
      setExistingLocalInstructions(updated);
    }
  };

  const handleKeyPressUrl = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmitUrl();
    }
  };

  const handleKeyPressLocal = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmitLocal();
    }
  };

  const idHelperRegexHint = `Pattern: ${ID_REGEX.source}`;

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'grey.50',
        p: 3,
        overflow: 'auto',
      }}
    >
      <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: 500,
          width: '100%',
          textAlign: 'center',
        }}
      >
        {/* Header */}
        <Box sx={{ mb: 4 }}>
          <Typography variant="h4" gutterBottom>
            Welcome to AI Research Coach
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Enter your identity, then choose instructions
          </Typography>
        </Box>

        {/* Identity (required) */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ textAlign: 'left' }}>
            Identity (required):
          </Typography>
          <TextField
            label="Student ID"
            type="text"
            value={studentIdInput}
            onChange={(e) => setStudentIdInput(e.target.value)}
            fullWidth
            autoFocus
            required
            placeholder="e.g., jane-doe"
            error={!!studentIdError}
            helperText={studentIdError ?? idHelperRegexHint}
          />
          <TextField
            label="Project ID"
            type="text"
            value={projectIdInput}
            onChange={(e) => setProjectIdInput(e.target.value)}
            fullWidth
            required
            placeholder="e.g., intro-2026"
            error={!!projectIdError}
            helperText={projectIdError ?? idHelperRegexHint}
          />
          {identityValid && (
            <Box sx={{ textAlign: 'left' }}>
              <Typography variant="caption" color="text.secondary" component="div">
                project_dir: <code>../..</code> (resolves to the session directory for{' '}
                <code>{trimmedStudentId}/{trimmedProjectId}</code>)
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                student_repo: <code>https://github.com/{trimmedStudentId}/{trimmedProjectId}</code>
              </Typography>
            </Box>
          )}
        </Box>

        <Divider sx={{ my: 3 }} />

        {/* Instructions URL Form */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ textAlign: 'left' }}>
            Use remote instructions:
          </Typography>
          <TextField
            label="Instructions URL"
            type="text"
            value={instructionsUrl}
            onChange={(e) => setInstructionsUrl(e.target.value)}
            onKeyPress={handleKeyPressUrl}
            fullWidth
            placeholder="https://example.com/instructions.md"
          />

          <Button
            variant="contained"
            size="large"
            onClick={handleSubmitUrl}
            disabled={!instructionsUrl.trim() || !identityValid}
          >
            Continue with URL
          </Button>
        </Box>

        <Divider sx={{ my: 3 }}>
          <Typography variant="body2" color="text.secondary">
            OR
          </Typography>
        </Divider>

        {/* Local Instructions Form */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ textAlign: 'left' }}>
            Use local instructions:
          </Typography>

          {/* Existing Local Instructions */}
          {existingLocalInstructions.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Button
                onClick={() => setShowExisting(!showExisting)}
                endIcon={showExisting ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ mb: 1, textTransform: 'none' }}
              >
                {showExisting ? 'Hide' : 'Show'} existing local instructions ({existingLocalInstructions.length})
              </Button>
              <Collapse in={showExisting}>
                <Paper variant="outlined" sx={{ maxHeight: 200, overflow: 'auto' }}>
                  <List dense disablePadding>
                    {existingLocalInstructions.map((name) => (
                      <ListItem
                        key={name}
                        disablePadding
                        secondaryAction={
                          <IconButton
                            edge="end"
                            aria-label="delete"
                            onClick={(e) => handleDeleteLocal(name, e)}
                            size="small"
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        }
                      >
                        <ListItemButton
                          onClick={() => handleSelectExisting(name)}
                          disabled={!identityValid}
                        >
                          <ListItemText primary={name} />
                        </ListItemButton>
                      </ListItem>
                    ))}
                  </List>
                </Paper>
              </Collapse>
            </Box>
          )}

          <TextField
            label="Local Instructions Name"
            type="text"
            value={localInstructionsName}
            onChange={(e) => setLocalInstructionsName(e.target.value)}
            onKeyPress={handleKeyPressLocal}
            fullWidth
            placeholder="e.g., my-project"
          />

          <Button
            variant="outlined"
            size="large"
            onClick={handleSubmitLocal}
            disabled={!localInstructionsName.trim() || !identityValid}
          >
            Continue with Local
          </Button>
        </Box>

        {!identityValid && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Enter a valid Student ID and Project ID above to enable the Continue buttons.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}

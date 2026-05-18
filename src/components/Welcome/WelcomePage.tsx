import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { isValidId, useStudentProject } from '../../studentProject';
import { useProjects, type Project } from '../../useProjects';

export interface WelcomeIdentity {
  studentId: string;
  projectId: string;
  pi: string;
}

interface WelcomePageProps {
  onInstructions: (instructionsUrl: string, identity: WelcomeIdentity) => void;
}

const getLocalInstructionsList = (): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('local_instructions_')) {
      keys.push(key.substring('local_instructions_'.length));
    }
  }
  return keys.sort();
};

export function WelcomePage({ onInstructions }: WelcomePageProps) {
  const { studentId, projectId, update: updateStudentProject } = useStudentProject();

  const [studentIdInput, setStudentIdInput] = useState(studentId ?? '');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [instructionsUrl, setInstructionsUrl] = useState('');
  const [localInstructionsName, setLocalInstructionsName] = useState('');
  const [existingLocalInstructions, setExistingLocalInstructions] = useState<string[]>(() =>
    getLocalInstructionsList()
  );
  const [showExisting, setShowExisting] = useState(() => getLocalInstructionsList().length > 0);

  const projectsState = useProjects();

  // Pre-select the previously-used project once the list loads
  useEffect(() => {
    if (projectsState.status === 'ok' && !selectedProject && projectId) {
      const match = projectsState.projects.find((p) => p.slug === projectId);
      if (match) setSelectedProject(match);
    }
  }, [projectsState, projectId, selectedProject]);

  const trimmedStudentId = studentIdInput.trim();

  const studentIdError = useMemo(() => {
    if (!trimmedStudentId) return null;
    return isValidId(trimmedStudentId) ? null : 'Use letters, digits, "_" or "-" (max 64 chars).';
  }, [trimmedStudentId]);

  const identityValid = isValidId(trimmedStudentId) && selectedProject !== null;

  const persistAndContinue = (instructionsRef: string) => {
    if (!identityValid || !selectedProject) return;
    const identity: WelcomeIdentity = {
      studentId: trimmedStudentId,
      projectId: selectedProject.slug,
      pi: selectedProject.pi,
    };
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
      localStorage.removeItem(`local_instructions_${name}`);
      const updated = getLocalInstructionsList();
      setExistingLocalInstructions(updated);
    }
  };

  const handleKeyPressUrl = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmitUrl();
  };

  const handleKeyPressLocal = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmitLocal();
  };

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
          maxWidth: 520,
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
            label="Your GitHub username"
            type="text"
            value={studentIdInput}
            onChange={(e) => setStudentIdInput(e.target.value)}
            fullWidth
            autoFocus
            required
            placeholder="your-github-username"
            error={!!studentIdError}
            helperText={studentIdError ?? ' '}
          />

          {/* Project picker */}
          <Typography variant="subtitle2" color="text.secondary" sx={{ textAlign: 'left', mt: 1 }}>
            Select a project:
          </Typography>

          {projectsState.status === 'loading' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Loading projects…
              </Typography>
            </Box>
          )}

          {projectsState.status === 'error' && (
            <Alert severity="error" sx={{ textAlign: 'left' }}>
              Could not load projects: {projectsState.message}
            </Alert>
          )}

          {projectsState.status === 'ok' && projectsState.projects.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'left' }}>
              No projects found in the repository.
            </Typography>
          )}

          {projectsState.status === 'ok' && projectsState.projects.length > 0 && (
            <Paper variant="outlined">
              <List dense disablePadding>
                {projectsState.projects.map((project, idx) => (
                  <Box key={project.slug}>
                    {idx > 0 && <Divider />}
                    <ListItemButton
                      selected={selectedProject?.slug === project.slug}
                      onClick={() => setSelectedProject(project)}
                      sx={{ flexDirection: 'column', alignItems: 'flex-start', py: 1.5 }}
                    >
                      <Typography variant="body2" fontWeight={600}>
                        {project.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        PI: {project.pi}
                        {project.description ? ` — ${project.description}` : ''}
                      </Typography>
                    </ListItemButton>
                  </Box>
                ))}
              </List>
            </Paper>
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

          {existingLocalInstructions.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Button
                onClick={() => setShowExisting(!showExisting)}
                endIcon={showExisting ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ mb: 1, textTransform: 'none' }}
              >
                {showExisting ? 'Hide' : 'Show'} existing local instructions (
                {existingLocalInstructions.length})
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
            Enter your GitHub username and select a project above to enable the Continue buttons.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}

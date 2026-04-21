import { useState } from 'react';
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

interface WelcomePageProps {
  onInstructions: (instructionsUrl: string) => void;
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
  const [instructionsUrl, setInstructionsUrl] = useState('');
  const [localInstructionsName, setLocalInstructionsName] = useState('');
  const [existingLocalInstructions, setExistingLocalInstructions] = useState<string[]>(() => getLocalInstructionsList());
  const [showExisting, setShowExisting] = useState(() => getLocalInstructionsList().length > 0);

  const handleSubmitUrl = () => {
    if (instructionsUrl.trim()) {
      onInstructions(instructionsUrl.trim());
    }
  };

  const handleSubmitLocal = () => {
    if (localInstructionsName.trim()) {
      onInstructions(`local:${localInstructionsName.trim()}`);
    }
  };

  const handleSelectExisting = (name: string) => {
    onInstructions(`local:${name}`);
  };

  const handleDeleteLocal = (name: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (window.confirm(`Are you sure you want to delete the local instructions "${name}"?`)) {
      const localKey = `local_instructions_${name}`;
      localStorage.removeItem(localKey);
      // Refresh the list
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
            Get started with instructions
          </Typography>
        </Box>

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
            autoFocus
            placeholder="https://example.com/instructions.md"
          />

          <Button
            variant="contained"
            size="large"
            onClick={handleSubmitUrl}
            disabled={!instructionsUrl.trim()}
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
                        <ListItemButton onClick={() => handleSelectExisting(name)}>
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
            disabled={!localInstructionsName.trim()}
          >
            Continue with Local
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}

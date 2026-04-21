import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
} from '@mui/material';
import { useState, useEffect } from 'react';

interface EditLocalInstructionsDialogProps {
  open: boolean;
  onClose: () => void;
  instructionsName: string;
  onSave: (content: string) => void;
}

export function EditLocalInstructionsDialog({
  open,
  onClose,
  instructionsName,
  onSave,
}: EditLocalInstructionsDialogProps) {
  const [content, setContent] = useState('');

  // Load content whenever dialog opens or instructionsName changes
  useEffect(() => {
    if (open) {
      const localKey = `local_instructions_${instructionsName}`;
      const existing = localStorage.getItem(localKey);
      // This is legitimate - we want to load fresh content when dialog opens
      // eslint-disable-next-line
      setContent(existing || '');
    }
  }, [open, instructionsName]);

  const handleSave = () => {
    onSave(content);
    onClose();
  };

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete the local instructions "${instructionsName}"?`)) {
      const localKey = `local_instructions_${instructionsName}`;
      localStorage.removeItem(localKey);
      onClose();
      // Reload to show the "No instructions found" message
      window.location.reload();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { height: '80vh', display: 'flex', flexDirection: 'column' }
      }}
    >
      <DialogTitle>
        <Box>
          <Typography variant="h6">Edit Local Instructions</Typography>
          <Typography variant="body2" color="text.secondary">
            Name: {instructionsName}
          </Typography>
        </Box>
      </DialogTitle>
      
      <DialogContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', p: 0 }}>
        <TextField
          multiline
          fullWidth
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Enter your instructions here..."
          variant="outlined"
          sx={{
            flex: 1,
            '& .MuiInputBase-root': {
              height: '100%',
              alignItems: 'flex-start',
            },
            '& .MuiInputBase-input': {
              height: '100% !important',
              overflow: 'auto !important',
            },
          }}
        />
      </DialogContent>

      <DialogActions sx={{ p: 2, gap: 1 }}>
        <Button
          onClick={handleDelete}
          color="error"
          variant="outlined"
          sx={{ mr: 'auto' }}
        >
          Delete
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', ml: 2 }}>
          {content.length} characters
        </Typography>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

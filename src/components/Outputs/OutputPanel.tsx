import { Box, Typography, IconButton, Button, CircularProgress, Alert, Paper } from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ViewListIcon from '@mui/icons-material/ViewList';
import { OutputItem } from './OutputItem';
import { OutputItem as OutputItemType } from '../../outputs/types';
import { useState, useEffect, useRef } from 'react';

interface OutputPanelProps {
  outputsHook: {
    outputs: OutputItemType[];
    loading: boolean;
    error: string | null;
    deleteOutput: (id: string) => void;
    clearAll: () => void;
    approveScript?: (id: string) => void;
    denyScript?: (id: string) => void;
    retryServerCheck?: (id: string) => void;
    useFallbackServer?: (id: string) => void;
  };
}

export function OutputPanel({ outputsHook }: OutputPanelProps) {
  const { outputs, loading, error, deleteOutput, clearAll, approveScript, denyScript, retryServerCheck, useFallbackServer } = outputsHook;
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevOutputsLengthRef = useRef<number>(0);

  // Scroll to bottom when new outputs are added
  useEffect(() => {
    if (outputs.length > prevOutputsLengthRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
    prevOutputsLengthRef.current = outputs.length;
  }, [outputs.length]);

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    await clearAll();
    setConfirmClear(false);
  };

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'background.default',
      }}
    >
      {/* Header */}
      <Box
        sx={{
          p: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: 'background.paper',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography
          variant="h6"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, userSelect: 'none' }}
        >
          <ViewListIcon color="primary" />
          Outputs
        </Typography>
        <Box>
          {outputs.length > 0 && (
            confirmClear ? (
              <Button
                size="small"
                variant="contained"
                color="error"
                startIcon={<DeleteSweepIcon />}
                onClick={handleClearAll}
              >
                Confirm Clear
              </Button>
            ) : (
              <IconButton
                size="small"
                onClick={handleClearAll}
                title="Clear all outputs"
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            )
          )}
        </Box>
      </Box>

      {/* Content Area */}
      <Box
        ref={scrollContainerRef}
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 2,
        }}
      >
        {loading ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
            }}
          >
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : outputs.length === 0 ? (
          <Paper
            elevation={0}
            sx={{
              p: 4,
              textAlign: 'center',
              backgroundColor: 'grey.50',
              borderRadius: 2,
              mt: 4,
            }}
          >
            <ViewListIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No Outputs Yet
            </Typography>
          </Paper>
        ) : (
          outputs.map((output) => (
            <OutputItem
              key={output.id}
              output={output}
              onDelete={deleteOutput}
              onApprove={approveScript}
              onDeny={denyScript}
              onRetryServerCheck={retryServerCheck}
              onUseFallbackServer={useFallbackServer}
            />
          ))
        )}
      </Box>

      {/* Footer with count */}
      {outputs.length > 0 && (
        <Box
          sx={{
            px: 2,
            py: 0.5,
            borderTop: 1,
            borderColor: 'divider',
            backgroundColor: 'grey.50',
            fontSize: '0.75rem',
            color: 'text.secondary',
          }}
        >
          {outputs.length} output{outputs.length !== 1 ? 's' : ''}
        </Box>
      )}
    </Box>
  );
}
import { Box, Paper, IconButton, Typography, Chip, Button, Alert, CircularProgress, Collapse } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import CodeIcon from '@mui/icons-material/Code';
import TerminalIcon from '@mui/icons-material/Terminal';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import BlockIcon from '@mui/icons-material/Block';
import ImageIcon from '@mui/icons-material/Image';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CloudIcon from '@mui/icons-material/Cloud';
import WebIcon from '@mui/icons-material/Web';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import HeightIcon from '@mui/icons-material/Height';
import { OutputItem as OutputItemType } from '../../outputs/types';
import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface OutputItemProps {
  output: OutputItemType;
  onDelete: (id: string) => void;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  onRetryServerCheck?: (id: string) => void;
  onUseFallbackServer?: (id: string) => void;
}

export function OutputItem({ output, onDelete, onApprove, onDeny, onRetryServerCheck, onUseFallbackServer }: OutputItemProps) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [iframeExpanded, setIframeExpanded] = useState(false);
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getTypeInfo = (type: string, scriptType?: string) => {
    switch (type) {
      case 'script':
        return {
          label: scriptType === 'python' ? 'Python Script' : 'Shell Script',
          icon: <CodeIcon fontSize="small" />,
          color: 'primary' as const,
        };
      case 'script-execution-output':
        return {
          label: scriptType === 'python' ? 'Python Output' : 'Shell Output',
          icon: <TerminalIcon fontSize="small" />,
          color: 'success' as const,
        };
      case 'image':
        return {
          label: 'Image',
          icon: <ImageIcon fontSize="small" />,
          color: 'secondary' as const,
        };
      case 'iframe':
        return {
          label: 'Web Content',
          icon: <WebIcon fontSize="small" />,
          color: 'info' as const,
        };
      default:
        return {
          label: type,
          icon: null,
          color: 'default' as const,
        };
    }
  };

  const typeInfo = getTypeInfo(output.type, output.type === 'script' ? output.metadata?.scriptType : undefined);

  return (
    <Paper
      elevation={1}
      sx={{
        p: 2,
        mb: 2,
        position: 'relative',
        '&:hover .delete-button': {
          opacity: 1,
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Chip
            icon={typeInfo.icon || undefined}
            label={typeInfo.label}
            size="small"
            color={typeInfo.color}
            variant="outlined"
          />
          <Typography variant="caption" color="text.secondary">
            {formatTimestamp(output.timestamp)}
          </Typography>
        </Box>
        <IconButton
          className="delete-button"
          size="small"
          onClick={() => onDelete(output.id)}
          sx={{
            opacity: 0,
            transition: 'opacity 0.2s',
          }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Content */}
      {output.type === 'image' ? (
        <Box
          sx={{
            backgroundColor: 'grey.50',
            p: 2,
            borderRadius: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <img
            src={`data:${output.metadata.mimeType};base64,${output.content}`}
            alt={output.metadata.relativePath}
            style={{
              maxWidth: '100%',
              maxHeight: '500px',
              objectFit: 'contain',
              borderRadius: '4px',
            }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 1 }}
          >
            {output.metadata.relativePath}
          </Typography>
        </Box>
      ) : output.type === 'iframe' ? (
        <Box>
          {output.metadata.title && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              {output.metadata.title}
            </Typography>
          )}
          <Box
            sx={{
              backgroundColor: 'grey.50',
              borderRadius: 1,
              overflow: 'hidden',
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <iframe
              src={output.metadata.url}
              style={{
                width: '100%',
                height: iframeExpanded ? '800px' : '500px',
                border: 'none',
                display: 'block',
              }}
              title={output.metadata.title || 'Embedded content'}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          </Box>
          <Box sx={{ mt: 1, display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            {!iframeExpanded && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<HeightIcon />}
                onClick={() => setIframeExpanded(true)}
              >
                Expand Height
              </Button>
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={<OpenInNewIcon />}
              onClick={() => window.open(output.metadata.url, '_blank')}
            >
              Open in New Tab
            </Button>
          </Box>
        </Box>
      ) : output.type === 'script' ? (
        <Box
          sx={{
            borderRadius: 1,
            maxHeight: '400px',
            overflow: 'auto',
            '& pre': {
              margin: 0,
              borderRadius: 1,
            },
          }}
        >
          <SyntaxHighlighter
            language={output.metadata?.scriptType === 'python' ? 'python' : 'bash'}
            style={vscDarkPlus}
            customStyle={{
              fontSize: '0.875rem',
              margin: 0,
              borderRadius: '4px',
            }}
          >
            {output.content}
          </SyntaxHighlighter>
        </Box>
      ) : (
        <Box
          sx={{
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            backgroundColor: 'grey.50',
            p: 1.5,
            borderRadius: 1,
            maxHeight: '400px',
            overflow: 'auto',
          }}
        >
          {output.content}
        </Box>
      )}

      {/* Server Health Check Status */}
      {(output.type === 'script') &&
       output.metadata?.pendingApproval &&
       output.metadata?.serverHealthCheck && (
        <Box sx={{ mt: 2 }}>
          {output.metadata.serverHealthCheck === 'checking' && (
            <Alert severity="info" icon={<CircularProgress size={20} />}>
              Checking if script server is running...
            </Alert>
          )}
          
          {output.metadata.serverHealthCheck === 'unhealthy' && (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => onRetryServerCheck?.(output.id)}
                  startIcon={<RefreshIcon />}
                >
                  Retry
                </Button>
              }
            >
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 1 }}>
                Script Server Not Running
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                The server must be running before scripts can be executed.
              </Typography>
              <Box>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => setInstructionsExpanded(!instructionsExpanded)}
                  endIcon={
                    <ExpandMoreIcon
                      sx={{
                        transform: instructionsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s'
                      }}
                    />
                  }
                  sx={{ textTransform: 'none', pl: 0 }}
                >
                  {instructionsExpanded ? 'Hide' : 'Show'} setup instructions
                </Button>
              </Box>
              <Collapse in={instructionsExpanded}>
                <Box
                  sx={{
                    mt: 1,
                    p: 1.5,
                    backgroundColor: 'rgba(0,0,0,0.05)',
                    borderRadius: 1,
                    fontFamily: 'monospace',
                    fontSize: '0.875rem'
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 1 }}>
                    Server unreachable. The default is the remote server at
                    https://airesearchcoach-server.airesearchcoach.org. To run
                    a local development server instead:
                  </Typography>
                  <Typography variant="body2" component="div" sx={{ mb: 1 }}>
                    1. Install the package (if not already installed):
                  </Typography>
                  <Box sx={{ pl: 2, mb: 1, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    cd python/ai-research-coach<br />
                    pip install -e .
                  </Box>
                  <Typography variant="body2" component="div" sx={{ mb: 1 }}>
                    2. Start the server in your working directory:
                  </Typography>
                  <Box sx={{ pl: 2, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    ai-research-coach start-server --passcode &lt;your-passcode&gt;
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    The local server will run on http://localhost:3339. Click "Try Local Server" below to switch to it.
                  </Typography>
                </Box>
              </Collapse>
              {output.metadata.serverError && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Error: {output.metadata.serverError}
                </Typography>
              )}
            </Alert>
          )}
        </Box>
      )}

      {/* Approval Buttons */}
      {(output.type === 'script') && output.metadata?.pendingApproval && (
        <Box sx={{ mt: 2, display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          {output.metadata.serverHealthCheck === 'unhealthy' && (
            <>
              <Button
                variant="outlined"
                color="primary"
                onClick={() => onUseFallbackServer?.(output.id)}
                startIcon={<CloudIcon />}
                size="small"
              >
                Try Local Server
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={() => onDeny?.(output.id)}
                startIcon={<BlockIcon />}
                size="small"
              >
                Cancel
              </Button>
            </>
          )}
          {output.metadata.serverHealthCheck === 'healthy' && (
            <>
              <Button
                variant="outlined"
                color="error"
                onClick={() => onDeny?.(output.id)}
                startIcon={<BlockIcon />}
                size="small"
              >
                Deny
              </Button>
              <Button
                variant="contained"
                color="success"
                onClick={() => onApprove?.(output.id)}
                startIcon={<PlayArrowIcon />}
                size="small"
              >
                Run Script
              </Button>
            </>
          )}
        </Box>
      )}

      {/* Approval Status */}
      {(output.type === 'script') && output.metadata?.approved && (
        <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          {output.metadata.executionStatus === 'running' && (
            <>
              <CircularProgress size={16} />
              <Chip
                label="Running..."
                color="info"
                size="small"
                variant="outlined"
              />
            </>
          )}
          {output.metadata.executionStatus === 'completed' && (
            <Chip
              label="Completed"
              color="success"
              size="small"
              variant="outlined"
            />
          )}
          {output.metadata.executionStatus === 'failed' && (
            <Chip
              label="Failed"
              color="error"
              size="small"
              variant="outlined"
            />
          )}
          {!output.metadata.executionStatus && (
            <Chip
              label="Approved"
              color="success"
              size="small"
              variant="outlined"
            />
          )}
        </Box>
      )}
      {(output.type === 'script') && output.metadata?.denied && (
        <Box sx={{ mt: 1 }}>
          <Chip
            label="Denied"
            color="error"
            size="small"
            variant="outlined"
          />
        </Box>
      )}

      {/* Metadata */}
      {(output.type === 'script-execution-output') && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Exit code: {output.metadata.exitCode}
          </Typography>
          {output.metadata.scriptPath && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
              Path: {output.metadata.scriptPath}
            </Typography>
          )}
        </Box>
      )}
    </Paper>
  );
}
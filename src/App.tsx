import InfoIcon from '@mui/icons-material/Info';
import EditIcon from '@mui/icons-material/Edit';
import { Alert, AppBar, Box, createTheme, CssBaseline, IconButton, ThemeProvider, Toolbar, Typography, Button } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AboutDialog from './components/About/AboutDialog';
import { AIResearchCoachChatPanel } from './components/Chat/ChatPanel';
import { MainLayout } from './components/Layout/MainLayout';
import { WelcomePage, type WelcomeIdentity } from './components/Welcome/WelcomePage';
import logoIcon from '/logo-white.svg';
import { useOutputs } from './outputs/useOutputs';
import { OutputPanel } from './components/Outputs/OutputPanel';
import { EditLocalInstructionsDialog } from './components/Instructions/EditLocalInstructionsDialog';
import { getServerUrl } from './serverConfig';
import { getOrPromptPasscode } from './chat/passcodeStorage';
import { ChatMessage } from './react-ai-chat';

// Create a custom theme with better colors for diffs
const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2',
    },
    success: {
      main: '#2e7d32',
      light: '#4caf50',
      // @ts-expect-error - MUI doesn't have lighter in the type but we can use it
      lighter: '#e8f5e9',
    },
    error: {
      main: '#d32f2f',
      light: '#ef5350',
      // @ts-expect-error - MUI doesn't have lighter in the type but we can use it
      lighter: '#ffebee',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          padding: 0,
          height: '100vh',
          overflow: 'hidden',
        },
        '#root': {
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
        },
      },
    },
  },
});

// Extract all query parameters except 'instructions'
const getAllQueryParameters = (): Record<string, string> => {
  const params = new URLSearchParams(window.location.search);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'instructions') {
      result[key] = decodeURIComponent(value);
    }
  });
  return result;
};

// Parse the "parameters:" line from instructions
const parseRequiredParameters = (text: string): string[] | null => {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('parameters:')) {
      const paramsStr = trimmed.substring(trimmed.indexOf(':') + 1).trim();
      return paramsStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
    }
  }
  return null;
};

// Escape special regex characters in parameter names
const escapeRegex = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Parse the "suggestions-enabled:" line from instructions
const parseSuggestionsEnabled = (text: string): boolean => {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('suggestions-enabled:')) {
      const value = trimmed.substring(trimmed.indexOf(':') + 1).trim().toLowerCase();
      return value === 'true';
    }
  }
  return true; // Default to true if not specified
};

// Parse the "recording-mode:" line from instructions. When omitted (alpha
// instructions) we default to "alpha". v1 instructions opt in with "split".
type RecordingMode = 'alpha' | 'split';
const parseRecordingMode = (text: string): RecordingMode => {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('recording-mode:')) {
      const value = trimmed.substring(trimmed.indexOf(':') + 1).trim().toLowerCase();
      if (value === 'split') return 'split';
      if (value === 'alpha') return 'alpha';
    }
  }
  return 'alpha';
};

// Process instructions: validate params and substitute
const processInstructions = (
  templateText: string,
  queryParams: Record<string, string>
): { success: boolean; error: string | null; text: string | null } => {
  const required = parseRequiredParameters(templateText);
  
  if (required && required.length > 0) {
    // Check for missing parameters
    const missing = required.filter(param => !(param in queryParams));
    
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required parameters: ${missing.join(', ')}`,
        text: null
      };
    }
  }
  
  // Replace all ${param} placeholders
  let processed = templateText;
  for (const [key, value] of Object.entries(queryParams)) {
    const regex = new RegExp(`\\$\\{${escapeRegex(key)}\\}`, 'g');
    processed = processed.replace(regex, value);
  }
  
  return { success: true, error: null, text: processed };
};

const getInstructionsUrlFromQuery = (): string | null => {
  const search = window.location.search;
  if (!search) return null;
  
  // Parse manually to avoid decoding
  const match = search.match(/[?&]instructions=([^&]*)/);
  return match ? match[1] : null;
}

const useInstructionsUrlFromQuery = (): string | null => {
  const [instructionsUrl, setInstructionsUrl] = useState<string | null>(
    getInstructionsUrlFromQuery()
  );

  useEffect(() => {
    const handlePopState = () => {
      setInstructionsUrl(getInstructionsUrlFromQuery());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return instructionsUrl;
};

interface SessionInit {
  studentId: string;
  projectId: string;
  pi: string;
  sessionStart: string;
  firstVisit: boolean;
  resumed: boolean;
  projectDescription: string;
  cumulativeReport: string;
  lastSessionSummary: string;
  coachStyleNotes: string;
  chatLog: { role: 'user' | 'assistant'; content: string; timestamp: string }[];
  coachModel: string;
}

interface SessionState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  init?: SessionInit;
  error?: string;
}

function AppContent() {
  const outputsHook = useOutputs();
  const outputEmitter = outputsHook.createEmitter();

  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [editInstructionsOpen, setEditInstructionsOpen] = useState(false);

  const instructionsUrl = useInstructionsUrlFromQuery();

  const { instructions, instructionsError, instructionsLoading, suggestionsEnabled, reloadInstructions, recordingMode, rawTemplate } = useInstructions(instructionsUrl);

  const queryParams = useMemo(() => getAllQueryParameters(), [instructionsUrl]);

  // For recording-mode=split, run /api/start-session before mounting the chat,
  // and use the response to fill template substitutions and rehydrate the
  // visible chat on resume.
  const [sessionState, setSessionState] = useState<SessionState>({ status: 'idle' });
  const [sessionRetryToken, setSessionRetryToken] = useState(0);

  useEffect(() => {
    if (recordingMode !== 'split') {
      setSessionState({ status: 'idle' });
      return;
    }
    if (!queryParams.student_id || !queryParams.project_id) {
      setSessionState({
        status: 'error',
        error: 'student_id and project_id are required for v1 (split recording mode).',
      });
      return;
    }
    let cancelled = false;
    const start = async () => {
      setSessionState({ status: 'loading' });
      const serverUrl = getServerUrl();
      const passcode = await getOrPromptPasscode(serverUrl);
      if (cancelled) return;
      if (!passcode) {
        setSessionState({ status: 'error', error: 'Passcode is required to start a session.' });
        return;
      }
      try {
        const response = await fetch(`${serverUrl}/api/start-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            passcode,
            student_id: queryParams.student_id,
            project_id: queryParams.project_id,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok || !data.success) {
          const detail = data?.error || data?.detail || `${response.status} ${response.statusText}`;
          setSessionState({ status: 'error', error: detail });
          return;
        }
        setSessionState({
          status: 'ready',
          init: {
            studentId: queryParams.student_id,
            projectId: queryParams.project_id,
            pi: data.pi || queryParams.pi || '',
            sessionStart: data.session_start,
            firstVisit: !!data.first_visit,
            resumed: !!data.resumed,
            projectDescription: data.project_description || '',
            cumulativeReport: data.cumulative_report || '',
            lastSessionSummary: data.last_session_summary || '',
            coachStyleNotes: data.coach_style_notes || '',
            chatLog: Array.isArray(data.chat_log) ? data.chat_log : [],
            coachModel: typeof data.coach_model === 'string' ? data.coach_model : '',
          },
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Unknown error';
        setSessionState({ status: 'error', error: `Failed to start session: ${msg}` });
      }
    };
    start();
    return () => {
      cancelled = true;
    };
  }, [recordingMode, queryParams.student_id, queryParams.project_id, queryParams.pi, sessionRetryToken]);

  // Once /api/start-session has succeeded for split mode, substitute the new
  // session-derived params into the raw template and re-process.
  const splitInstructions = useMemo(() => {
    if (recordingMode !== 'split') return null;
    if (sessionState.status !== 'ready' || !sessionState.init || !rawTemplate) return null;
    const allParams: Record<string, string> = {
      ...queryParams,
      student_id: sessionState.init.studentId,
      project_id: sessionState.init.projectId,
      pi: sessionState.init.pi,
      session_start: sessionState.init.sessionStart,
      first_visit: sessionState.init.firstVisit ? 'true' : 'false',
      project_description: sessionState.init.projectDescription,
      cumulative_report: sessionState.init.cumulativeReport,
      last_session_summary: sessionState.init.lastSessionSummary,
      coach_style_notes: sessionState.init.coachStyleNotes,
    };
    return processInstructions(rawTemplate, allParams);
  }, [recordingMode, sessionState, queryParams, rawTemplate]);

  // Effective values shown to the chat panel.
  const effectiveInstructions = recordingMode === 'split'
    ? (splitInstructions?.text ?? null)
    : instructions;
  const effectiveInstructionsError = recordingMode === 'split'
    ? (sessionState.status === 'error'
        ? sessionState.error ?? 'Failed to start session'
        : (splitInstructions && !splitInstructions.success ? splitInstructions.error : instructionsError))
    : instructionsError;
  const effectiveInstructionsLoading = recordingMode === 'split'
    ? (instructionsLoading || sessionState.status === 'loading' || sessionState.status === 'idle')
    : instructionsLoading;

  // Rehydrate chat from server's chat_log when resumed===true.
  const rehydratedChat = useMemo(() => {
    if (recordingMode !== 'split') return null;
    if (sessionState.status !== 'ready' || !sessionState.init) return null;
    if (!sessionState.init.resumed) return null;
    const messages: ChatMessage[] = sessionState.init.chatLog.map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content }
        : { role: 'assistant', content: m.content }
    );
    return messages;
  }, [recordingMode, sessionState]);

  const handleInstructions = useCallback(
    (url: string | null, identity?: WelcomeIdentity) => {
      // set the query parameter without reloading the page
      // Build the URL manually so the `instructions` value is not URL-encoded
      // (existing convention; getInstructionsUrlFromQuery parses it raw).
      let newUrl = window.location.pathname;
      if (url) {
        const parts = [`instructions=${url}`];
        if (identity) {
          parts.push(`student_id=${encodeURIComponent(identity.studentId)}`);
          parts.push(`project_id=${encodeURIComponent(identity.projectId)}`);
          parts.push(`pi=${encodeURIComponent(identity.pi)}`);
        }
        newUrl = `${newUrl}?${parts.join('&')}`;
      }
      window.history.pushState({}, '', newUrl);

      // Trigger a popstate event to update the component
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    []
  );

  const handleSaveLocalInstructions = useCallback((content: string) => {
    if (instructionsUrl?.startsWith('local:')) {
      const name = instructionsUrl.substring(6);
      const localKey = `local_instructions_${name}`;
      localStorage.setItem(localKey, content);
      // Trigger reload of instructions
      reloadInstructions();
    }
  }, [instructionsUrl, reloadInstructions]);

  // Check if we're using local instructions
  const isLocalInstructions = instructionsUrl?.startsWith('local:') || false;
  const localInstructionsName = isLocalInstructions ? instructionsUrl!.substring(6) : '';

  // Show welcome page if no instructions URL is specified
  const showWelcome = !instructionsUrl;

  if (showWelcome) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {/* Minimal App Bar for welcome page */}
        <AppBar position="static" elevation={1}>
          <Toolbar variant="dense">
            <Box component="img" src={logoIcon} alt="Logo" sx={{ height: 24, mr: 1 }} />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              AI Research Coach
            </Typography>
            <IconButton
              color="inherit"
              onClick={() => setAboutDialogOpen(true)}
              size="small"
              sx={{ mr: 1 }}
            >
              <InfoIcon />
            </IconButton>
          </Toolbar>
        </AppBar>

        {/* Welcome Page */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          <WelcomePage onInstructions={handleInstructions} />
        </Box>

        {/* About Dialog */}
        <AboutDialog
          open={aboutDialogOpen}
          onClose={() => setAboutDialogOpen(false)}
        />
      </Box>
    );
  }

  // For split mode, render an error/retry banner instead of the chat when
  // session start fails. The chat does not mount until /api/start-session
  // returns successfully.
  const splitSessionFailed =
    recordingMode === 'split' && sessionState.status === 'error';

  const leftPanel = splitSessionFailed ? (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => setSessionRetryToken((t) => t + 1)}
          >
            Retry
          </Button>
        }
      >
        <Typography variant="subtitle2" gutterBottom>
          Could not start session
        </Typography>
        <Typography variant="body2">
          {sessionState.error || 'Unknown error'}
        </Typography>
      </Alert>
    </Box>
  ) : (
    <AIResearchCoachChatPanel
      instructions={effectiveInstructions}
      instructionsError={effectiveInstructionsError}
      instructionsLoading={effectiveInstructionsLoading}
      suggestionsEnabled={suggestionsEnabled}
      outputEmitter={outputEmitter}
      requestApproval={outputsHook.requestApproval}
      updateServerHealth={outputsHook.updateServerHealth}
      updateExecutionStatus={outputsHook.updateExecutionStatus}
      recordingMode={recordingMode}
      pi={sessionState.init?.pi || queryParams.pi}
      sessionStart={sessionState.init?.sessionStart}
      rehydratedMessages={rehydratedChat ?? undefined}
      coachModel={sessionState.init?.coachModel}
    />
  )

  const rightPanel = (
    <OutputPanel
      outputsHook={outputsHook}
    />
  )

  // Check if output panel should be hidden via query parameter
  const hideOutputPanel = new URLSearchParams(window.location.search).get('hide-output-panel') === '1';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* App Bar */}
      <AppBar position="static" elevation={1}>
        <Toolbar variant="dense">
          <IconButton
            color="inherit"
            onClick={() => handleInstructions(null)}
            size="small"
            sx={{ p: 0.5, mr: 1 }}
          >
            <Box component="img" src={logoIcon} alt="Logo" sx={{ height: 24 }} />
          </IconButton>
          <IconButton
            color="inherit"
            onClick={() => setAboutDialogOpen(true)}
            size="small"
            sx={{ mr: 1 }}
          >
            <InfoIcon />
          </IconButton>
          {/* Show local instructions name and Edit button when using local instructions */}
          {isLocalInstructions && (
            <>
              <Typography variant="body2" sx={{ ml: 2, opacity: 0.9 }}>
                Local: {localInstructionsName}
              </Typography>
              <Button
                color="inherit"
                startIcon={<EditIcon />}
                onClick={() => setEditInstructionsOpen(true)}
                size="small"
                sx={{ ml: 'auto' }}
              >
                Edit Instructions
              </Button>
            </>
          )}
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        <MainLayout
          leftPanel={leftPanel}
          rightPanel={rightPanel}
          initialLeftWidth={50}
          minLeftWidth={25}
          maxLeftWidth={75}
          hideRightPanel={hideOutputPanel}
        />
      </Box>

      {/* About Dialog */}
      <AboutDialog
        open={aboutDialogOpen}
        onClose={() => setAboutDialogOpen(false)}
      />

      {/* Edit Local Instructions Dialog */}
      {isLocalInstructions && (
        <EditLocalInstructionsDialog
          open={editInstructionsOpen}
          onClose={() => setEditInstructionsOpen(false)}
          instructionsName={localInstructionsName}
          onSave={handleSaveLocalInstructions}
        />
      )}
    </Box>
  );
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppContent />
    </ThemeProvider>
  );
}

// const CACHE_DURATION_MS = 60 * 1000; // 1 minute
const CACHE_DURATION_MS = 0; // Disable caching for development

interface CachedInstructions {
  url: string;
  text: string;
  timestamp: number;
}

const getCachedInstructions = (url: string): string | null => {
  try {
    const cached = localStorage.getItem('instructions_cache');
    if (!cached) return null;

    const data: CachedInstructions = JSON.parse(cached);
    const now = Date.now();

    // Check if cache is valid (same URL and not expired)
    if (data.url === url && now - data.timestamp < CACHE_DURATION_MS) {
      return data.text;
    }

    return null;
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
};

const setCachedInstructions = (url: string, text: string): void => {
  try {
    const data: CachedInstructions = {
      url,
      text,
      timestamp: Date.now(),
    };
    localStorage.setItem('instructions_cache', JSON.stringify(data));
  } catch (error) {
    console.error('Error writing cache:', error);
  }
};

const useInstructions = (url: string | null) => {
  const [instructions, setInstructions] = useState<string | null>(null);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);
  const [instructionsLoading, setInstructionsLoading] = useState<boolean>(false);
  const [suggestionsEnabled, setSuggestionsEnabled] = useState<boolean>(true);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('alpha');
  const [rawTemplate, setRawTemplate] = useState<string | null>(null);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useEffect(() => {
    if (!url) {
      setInstructions(null);
      setInstructionsError(null);
      setRawTemplate(null);
      setRecordingMode('alpha');
      return;
    }

    const queryParams = getAllQueryParameters();

    // Check if this is a local instructions reference
    if (url.startsWith('local:')) {
      const name = url.substring(6); // Remove 'local:' prefix
      const localKey = `local_instructions_${name}`;
      const templateText = localStorage.getItem(localKey);
      
      if (templateText) {
        console.info('Using local instructions:', name);
        console.info(templateText);
        
        // Parse suggestions-enabled setting
        setSuggestionsEnabled(parseSuggestionsEnabled(templateText));
        const mode = parseRecordingMode(templateText);
        setRecordingMode(mode);
        setRawTemplate(templateText);

        // For split mode, defer parameter substitution to App.tsx after
        // /api/start-session returns. Don't surface "missing parameters"
        // errors from URL-only substitution.
        if (mode === 'split') {
          setInstructions(null);
          setInstructionsError(null);
        } else {
          const result = processInstructions(templateText, queryParams);
          if (result.success) {
            setInstructions(result.text);
            setInstructionsError(null);
          } else {
            setInstructions(null);
            setInstructionsError(result.error);
          }
        }
      } else {
        console.info('No local instructions found for:', name);
        setInstructions(`No local instructions found for "${name}". Click "Edit Instructions" to create them.`);
        setInstructionsError(null);
        setRawTemplate(null);
      }
      setInstructionsLoading(false);
      return;
    }

    // Check cache for template
    const cachedTemplate = getCachedInstructions(url);
    if (cachedTemplate) {
      console.info('Using cached instructions template');
      console.info(cachedTemplate);
      
      // Parse suggestions-enabled setting
      setSuggestionsEnabled(parseSuggestionsEnabled(cachedTemplate));
      const cachedMode = parseRecordingMode(cachedTemplate);
      setRecordingMode(cachedMode);
      setRawTemplate(cachedTemplate);

      if (cachedMode === 'split') {
        setInstructions(null);
        setInstructionsError(null);
      } else {
        const result = processInstructions(cachedTemplate, queryParams);
        if (result.success) {
          setInstructions(result.text);
          setInstructionsError(null);
        } else {
          setInstructions(null);
          setInstructionsError(result.error);
        }
      }
      setInstructionsLoading(false);
      return;
    }

    let isCancelled = false;

    const fetchInstructions = async () => {
      setInstructionsLoading(true);
      try {
        const response = await fetch(filterInstructionsUrl(url));
        if (!response.ok) {
          throw new Error(`Failed to fetch instructions from ${url}: ${response.statusText}`);
        }
        const templateText = await response.text();
        
        if (!isCancelled) {
          console.info('INSTRUCTIONS TEMPLATE:')
          console.info(templateText)
          
          // Parse suggestions-enabled setting
          setSuggestionsEnabled(parseSuggestionsEnabled(templateText));
          const fetchedMode = parseRecordingMode(templateText);
          setRecordingMode(fetchedMode);
          setRawTemplate(templateText);

          // Cache the raw template
          setCachedInstructions(url, templateText);
          
          if (fetchedMode === 'split') {
            setInstructions(null);
            setInstructionsError(null);
          } else {
            const result = processInstructions(templateText, queryParams);
            if (result.success) {
              setInstructions(result.text);
              setInstructionsError(null);
            } else {
              setInstructions(null);
              setInstructionsError(result.error);
            }
          }
        }
      } catch (error) {
        console.error(error);
        if (!isCancelled) {
          setInstructions(null);
          setInstructionsError(`Error loading instructions: ${error}`);
        }
      } finally {
        if (!isCancelled) {
          setInstructionsLoading(false);
        }
      }
    };

    fetchInstructions();

    return () => {
      isCancelled = true;
    };
  }, [url, reloadTrigger]);

  const reloadInstructions = useCallback(() => {
    setReloadTrigger(prev => prev + 1);
  }, []);

  return {
    instructions,
    instructionsError,
    instructionsLoading,
    suggestionsEnabled,
    recordingMode,
    rawTemplate,
    reloadInstructions,
  };
};

const filterInstructionsUrl = (url: string): string => {
  // if url is of the form https://github.com/user/repo/blob/branch/path/to/file.md
  // convert it to https://raw.githubusercontent.com/user/repo/branch/path/to/file.md
  const githubBlobPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
  const match = url.match(githubBlobPattern);
  if (match) {
    const user = match[1];
    const repo = match[2];
    const branch = match[3];
    const path = match[4];
    return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
  }
  return url;
};

export default App;

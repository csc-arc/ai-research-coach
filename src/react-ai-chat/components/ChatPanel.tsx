import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Box,
  CircularProgress,
  Typography,
  IconButton,
  Paper,
  Alert,
  Chip,
  Tooltip,
  Button,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import SettingsIcon from "@mui/icons-material/Settings";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import DownloadIcon from "@mui/icons-material/Download";
// import UploadIcon from "@mui/icons-material/Upload";
import CompressIcon from "@mui/icons-material/Compress";
import ChatInput from "./ChatInput";
import MessageItem from "./MessageItem";
import SuggestedPrompts from "./SuggestedPrompts";
import CompressConfirmDialog from "./CompressConfirmDialog";
import ChatSettingsDialog from "./ChatSettingsDialog";
import useChat from "../hooks/useChat";
import { useTypingEffect } from "../hooks/useTypingEffect";
import { ChatMessage, ChatPanelProps, PasteMeta } from "../types";

export function ChatPanel({
  onCompletion,
  tools = [],
  toolContext = {},
  systemPrompt = "",
  availableModels = [],
  defaultModel,
  cheapModels = [],
  title = "Assistant",
  placeholder = "Type your message...",
  emptyStateContent,
  enableSuggestions = true,
  enableCompression = true,
  enableExport = true,
  enableModelSelection = true,
  onMessageSent,
  onUserMessageSubmit,
  onAssistantMessagesSettled,
  onError,
  onChatCleared,
  onModelChange,
  isLoading = false,
  hideToolDetails = false,
  autoStartConversation = false,
  initialMessages,
}: ChatPanelProps) {
  const {
    chat,
    submitUserMessage,
    triggerAgentGreeting,
    responding,
    compressing,
    partialResponse,
    setChatModel,
    error,
    clearChat,
    abortResponse,
    revertToMessage,
    compressConversation,
    currentSuggestions,
    loadChat,
  } = useChat({
    onCompletion,
    tools,
    toolContext,
    systemPrompt,
    defaultModel: defaultModel || availableModels[0]?.model || "default",
    availableModels,
  });

  const [newPrompt, setNewPrompt] = useState<string>("");
  const [compressDialogOpen, setCompressDialogOpen] = useState<boolean>(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState<boolean>(false);
  const [errorExpanded, setErrorExpanded] = useState<boolean>(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  // const fileInputRef = useRef<HTMLInputElement>(null);

  // Guard so we fire at most once per mount, even if conditions change multiple times
  const hasAutoStartedRef = useRef(false);
  const hasRehydratedRef = useRef(false);

  // One-shot rehydration: when `initialMessages` is provided on first render
  // with at least one message, call loadChat with them. Subsequent changes
  // are ignored. This must run before auto-start so a resumed session does
  // not trigger a duplicate greeting.
  useEffect(() => {
    if (hasRehydratedRef.current) return;
    if (!initialMessages || initialMessages.length === 0) return;
    hasRehydratedRef.current = true;
    // Mark auto-start as already-fired so resumed sessions don't re-greet.
    hasAutoStartedRef.current = true;
    loadChat({
      messages: initialMessages,
      totalUsage: { promptTokens: 0, completionTokens: 0, estimatedCost: 0 },
      model: defaultModel || availableModels[0]?.model || "default",
    });
  }, [initialMessages, loadChat, defaultModel, availableModels]);

  // Auto-start: trigger agent greeting when conditions are met on cold-start.
  // Fires only when autoStartConversation is true, the chat has no messages yet,
  // we're not already loading/responding, and the system prompt is ready.
  useEffect(() => {
    if (
      autoStartConversation &&
      !hasAutoStartedRef.current &&
      chat.messages.length === 0 &&
      !responding &&
      !isLoading &&
      systemPrompt
    ) {
      hasAutoStartedRef.current = true;
      triggerAgentGreeting();
    }
  }, [autoStartConversation, chat.messages.length, responding, isLoading, systemPrompt, triggerAgentGreeting]);

  // Compression threshold (number of messages before suggesting compression)
  const compressionThreshold = 35;

  // Call error callback when error changes
  useEffect(() => {
    if (error && onError) {
      onError(new Error(error));
    }
  }, [error, onError]);

  // Extract the full streamed text from the last in-progress assistant message.
  // useTypingEffect drips this to the display at a natural pace.
  const inProgressAssistantContent = (() => {
    if (!responding || !partialResponse) return "";
    const last = partialResponse[partialResponse.length - 1];
    return last?.role === "assistant" && typeof last.content === "string"
      ? last.content
      : "";
  })();
  const displayedContent = useTypingEffect(inProgressAssistantContent, responding);

  // All messages including partial response (last in-progress assistant message
  // uses the typed/dripped content rather than the full streamed content)
  const allMessages = useMemo(() => {
    const messages = chat.messages.map((m) => ({
      message: m,
      inProgress: false,
    }));
    if (responding && partialResponse) {
      return [
        ...messages,
        ...partialResponse.map((m, i) => {
          if (
            i === partialResponse.length - 1 &&
            m.role === "assistant" &&
            typeof m.content === "string"
          ) {
            return { message: { ...m, content: displayedContent }, inProgress: true };
          }
          return { message: m, inProgress: true };
        }),
      ];
    }
    return messages;
  }, [chat.messages, responding, partialResponse, displayedContent]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, [allMessages]);

  // Track which assistant messages have already been forwarded to
  // onAssistantMessagesSettled so we don't double-log on every rerender.
  // We only fire the callback for messages that arrived during a "real"
  // turn — i.e., a transition from responding=true to responding=false.
  // External setChat() calls (loadChat, replace_with_summary) advance the
  // index without firing.
  const lastSettledIndexRef = useRef<number>(-1);
  const wasRespondingRef = useRef<boolean>(false);

  const handleSubmit = useCallback(async (pasteMeta?: PasteMeta) => {
    if (newPrompt.trim() === "" || responding || compressing) return;
    const message = newPrompt.trim();
    setNewPrompt("");
    // Log the user turn synchronously before the completion call so the
    // fast-eval-awaited-by-completion design works. Failures must never
    // block the chat — the callback itself is responsible for swallowing
    // its errors and surfacing console warnings.
    if (onUserMessageSubmit) {
      try {
        await onUserMessageSubmit(message, pasteMeta);
      } catch (e) {
        console.warn("onUserMessageSubmit failed:", e);
      }
    }
    submitUserMessage(message);
    onMessageSent?.(message);
  }, [newPrompt, submitUserMessage, responding, compressing, onMessageSent, onUserMessageSubmit]);

  // Fire onAssistantMessagesSettled when assistant turns settle. We only
  // forward messages with index > lastSettledIndexRef.current so multiple
  // settles inside a single tool-loop don't re-emit the same assistant
  // message. User messages are intentionally not included here — they are
  // already logged at submit time.
  useEffect(() => {
    if (responding) {
      wasRespondingRef.current = true;
      return;
    }
    const justSettled = wasRespondingRef.current;
    wasRespondingRef.current = false;

    if (!justSettled || !onAssistantMessagesSettled) {
      // Either we never started a real turn (loadChat / clearChat / mount)
      // or the consumer doesn't care — advance the index silently so a
      // future genuine settle doesn't re-emit historical messages.
      lastSettledIndexRef.current = chat.messages.length - 1;
      return;
    }
    const start = lastSettledIndexRef.current + 1;
    lastSettledIndexRef.current = chat.messages.length - 1;
    if (start >= chat.messages.length) return;
    const settled: typeof chat.messages = [];
    for (let i = start; i < chat.messages.length; i++) {
      const m = chat.messages[i];
      if (m.role === "assistant") {
        settled.push(m);
      }
    }
    if (settled.length > 0) {
      onAssistantMessagesSettled(settled);
    }
  }, [chat.messages, responding, onAssistantMessagesSettled]);

  // Reset the settled-index tracker when the chat is cleared.
  useEffect(() => {
    if (chat.messages.length === 0) {
      lastSettledIndexRef.current = -1;
      wasRespondingRef.current = false;
    }
  }, [chat.messages.length]);

  const handleNewChat = useCallback(() => {
    clearChat();
    setNewPrompt("");
    onChatCleared?.();
  }, [clearChat, onChatCleared]);

  const handleCompressClick = useCallback(() => {
    setCompressDialogOpen(true);
  }, []);

  const handleCompressConfirm = useCallback(async () => {
    setCompressDialogOpen(false);
    await compressConversation();
  }, [compressConversation]);

  const handleCompressCancel = useCallback(() => {
    setCompressDialogOpen(false);
  }, []);

  const handleSettingsClick = useCallback(() => {
    setSettingsDialogOpen(true);
  }, []);

  const handleSettingsClose = useCallback(() => {
    setSettingsDialogOpen(false);
  }, []);

  const handleModelChange = useCallback(
    (model: string) => {
      setChatModel(model);
      onModelChange?.(model);
    },
    [setChatModel, onModelChange]
  );

  const handleDownloadMarkdown = useCallback(() => {
    const extractText = (
      content: ChatMessage["content"]
    ): string => {
      if (content == null) return "";
      if (typeof content === "string") return content;
      return content
        .map((part) =>
          part.type === "text" ? part.text : "[image]"
        )
        .join("\n\n");
    };

    const lines: string[] = [];
    const now = new Date();
    lines.push("# AI Research Coach — Conversation");
    lines.push("");
    lines.push(`_Exported ${now.toISOString().replace("T", " ").slice(0, 16)} UTC_`);
    lines.push("");
    lines.push("---");
    lines.push("");

    for (const msg of chat.messages) {
      if (msg.role === "tool") continue;
      const text = extractText(msg.content).trim();
      if (!text) continue;
      const heading = msg.role === "user" ? "## You" : "## Assistant";
      lines.push(heading);
      lines.push("");
      lines.push(text);
      lines.push("");
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversation-${now.toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [chat]);

  // const handleDownloadChat = useCallback(() => {
  //   const chatExport = {
  //     version: "1.0",
  //     exportDate: new Date().toISOString(),
  //     chat: {
  //       model: chat.model,
  //       messages: chat.messages,
  //       totalUsage: chat.totalUsage,
  //     },
  //   };
  //
  //   const blob = new Blob([JSON.stringify(chatExport, null, 2)], {
  //     type: "application/json",
  //   });
  //   const url = URL.createObjectURL(blob);
  //   const a = document.createElement("a");
  //   a.href = url;
  //   a.download = `chat-${new Date().toISOString().slice(0, 10)}.json`;
  //   document.body.appendChild(a);
  //   a.click();
  //   document.body.removeChild(a);
  //   URL.revokeObjectURL(url);
  // }, [chat]);

  // const handleUploadChat = useCallback(() => {
  //   fileInputRef.current?.click();
  // }, []);

  // const handleFileChange = useCallback(
  //   (event: React.ChangeEvent<HTMLInputElement>) => {
  //     const file = event.target.files?.[0];
  //     if (!file) return;
  //
  //     const reader = new FileReader();
  //     reader.onload = (e) => {
  //       try {
  //         const content = e.target?.result as string;
  //         const parsed = JSON.parse(content);
  //
  //         // Validate the structure
  //         if (!parsed.chat || !parsed.chat.messages || !Array.isArray(parsed.chat.messages)) {
  //           throw new Error("Invalid chat file format");
  //         }
  //
  //         // Load the chat using the loadChat function from useChat
  //         if (window.confirm(`Load chat with ${parsed.chat.messages.length} messages? This will replace the current conversation.`)) {
  //           loadChat(parsed.chat);
  //         }
  //       } catch (err) {
  //         alert(`Error loading chat file: ${err instanceof Error ? err.message : "Unknown error"}`);
  //       }
  //     };
  //     reader.readAsText(file);
  //
  //     // Reset file input
  //     event.target.value = "";
  //   },
  //   [loadChat]
  // );

  // Get display label for current model
  const currentModelLabel = useMemo(() => {
    const model = availableModels.find((m) => m.model === chat.model);
    return model?.label || chat.model.split("/").pop() || chat.model;
  }, [availableModels, chat.model]);

  // Default empty state
  const defaultEmptyState = (
    <Paper
      elevation={0}
      sx={{
        p: 4,
        textAlign: "center",
        backgroundColor: "grey.50",
        borderRadius: 2,
        m: "auto",
        maxWidth: 400,
      }}
    >
      <SmartToyIcon sx={{ fontSize: 48, color: "primary.main", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        Ready to Help!
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Start a conversation by typing a message below.
      </Typography>
    </Paper>
  );

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "background.default",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          p: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          backgroundColor: "background.paper",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="h6"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            userSelect: "none",
          }}
        >
          <SmartToyIcon color="primary" />
          {title}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {responding && (
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={abortResponse}
              sx={{ mr: 1 }}
            >
              Stop
            </Button>
          )}
          {enableModelSelection && availableModels.length > 0 && (
            <Chip
              label={currentModelLabel}
              size="small"
              variant="outlined"
              onClick={handleSettingsClick}
              sx={{ fontSize: "0.7rem", cursor: "pointer" }}
            />
          )}
          {enableCompression && (
            <Tooltip title="Compress Conversation">
              <span>
                <IconButton
                  size="small"
                  onClick={handleCompressClick}
                  disabled={chat.messages.length < 3 || compressing}
                >
                  <CompressIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {/* JSON upload + JSON download buttons disabled; the only export is Markdown below */}
          {enableExport && (
            <Tooltip title="Download conversation (Markdown)">
              <span>
                <IconButton
                  size="small"
                  onClick={handleDownloadMarkdown}
                  disabled={chat.messages.length === 0}
                >
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title="New Chat">
            <span>
              <IconButton
                size="small"
                onClick={handleNewChat}
                disabled={chat.messages.length === 0}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {enableModelSelection && availableModels.length > 1 && (
            <Tooltip title="Settings">
              <IconButton size="small" onClick={handleSettingsClick}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>

      {/* Chat Messages Area */}
      <Box
        ref={conversationRef}
        sx={{
          flex: 1,
          overflow: "auto",
          p: 2,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {isLoading ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              m: "auto",
              gap: 2,
            }}
          >
            <CircularProgress />
            <Typography variant="body2" color="text.secondary">
              Loading...
            </Typography>
          </Box>
        ) : allMessages.length === 0 ? (
          emptyStateContent || defaultEmptyState
        ) : (
          <>
            {allMessages.map(({ message, inProgress }, index) => {
              // Find the actual index in chat.messages (excluding partial responses)
              const isFromChat = index < chat.messages.length;
              const chatIndex = isFromChat ? index : -1;
              // Can revert if it's not the last message and not in progress
              const canRevert =
                isFromChat &&
                index < chat.messages.length - 1 &&
                !responding;

              return (
                <MessageItem
                  key={index}
                  message={message}
                  inProgress={inProgress}
                  messageIndex={chatIndex}
                  onRevert={revertToMessage}
                  canRevert={canRevert}
                  hideToolDetails={hideToolDetails}
                />
              );
            })}
            {responding && !partialResponse && (
              <Box
                sx={{ display: "flex", justifyContent: "flex-start", mb: 2 }}
              >
                <Paper
                  elevation={1}
                  sx={{
                    p: 2,
                    backgroundColor: "grey.100",
                    borderRadius: 2,
                    borderTopLeftRadius: 0,
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography
                      variant="body2"
                      sx={{ fontStyle: "italic", color: "text.secondary" }}
                    >
                      Thinking...
                    </Typography>
                  </Box>
                </Paper>
              </Box>
            )}
            {compressing && (
              <Box
                sx={{ display: "flex", justifyContent: "flex-start", mb: 2 }}
              >
                <Paper
                  elevation={1}
                  sx={{
                    p: 2,
                    backgroundColor: "grey.100",
                    borderRadius: 2,
                    borderTopLeftRadius: 0,
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography
                      variant="body2"
                      sx={{ fontStyle: "italic", color: "text.secondary" }}
                    >
                      Compressing conversation...
                    </Typography>
                  </Box>
                </Paper>
              </Box>
            )}
          </>
        )}
      </Box>

      {/* Error Display */}
      {error && (
        <Alert
          severity="error"
          sx={{ mx: 2, mb: 1 }}
          action={
            error.length > 100 ? (
              <IconButton
                size="small"
                onClick={() => setErrorExpanded(!errorExpanded)}
                sx={{ color: "inherit" }}
              >
                {errorExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            ) : null
          }
        >
          {error.length > 100 && !errorExpanded ? (
            <Box>
              <Typography variant="body2" component="span">
                {error.substring(0, 100)}...
              </Typography>
            </Box>
          ) : (
            <Box sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {error}
            </Box>
          )}
        </Alert>
      )}

      {/* Compression Suggestion Warning */}
      {enableCompression &&
        chat.messages.length > compressionThreshold &&
        !compressing && (
          <Alert
            severity="info"
            sx={{ mx: 2, mb: 1 }}
            action={
              <Button
                size="small"
                color="inherit"
                onClick={handleCompressClick}
                startIcon={<CompressIcon />}
              >
                Compress
              </Button>
            }
          >
            The conversation is getting long ({chat.messages.length} messages).
            Consider compressing it to maintain context while reducing token
            usage.
          </Alert>
        )}

      {/* Suggested Prompts */}
      {enableSuggestions && !responding && !compressing && (
        <SuggestedPrompts
          suggestions={currentSuggestions}
          onSuggestionClick={(suggestion) => {
            submitUserMessage(suggestion);
            onMessageSent?.(suggestion);
          }}
          disabled={responding || compressing}
        />
      )}

      {/* Input Area */}
      <ChatInput
        value={newPrompt}
        onChange={setNewPrompt}
        onSubmit={handleSubmit}
        disabled={responding || compressing || isLoading}
        placeholder={
          isLoading
            ? "Loading..."
            : compressing
              ? "Compressing conversation..."
              : placeholder
        }
      />

      {/* Usage Display */}
      {chat.totalUsage.estimatedCost > 0 && (
        <Box
          sx={{
            px: 2,
            py: 0.5,
            borderTop: 1,
            borderColor: "divider",
            backgroundColor: "grey.50",
            fontSize: "0.75rem",
            color: "text.secondary",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            Tokens: {chat.totalUsage.promptTokens.toLocaleString()} prompt /{" "}
            {chat.totalUsage.completionTokens.toLocaleString()} completion
          </span>
          <span>Est. cost: ${chat.totalUsage.estimatedCost.toFixed(4)}</span>
        </Box>
      )}

      {/* Compress Confirmation Dialog */}
      {enableCompression && (
        <CompressConfirmDialog
          open={compressDialogOpen}
          onClose={handleCompressCancel}
          onConfirm={handleCompressConfirm}
          messageCount={chat.messages.length}
        />
      )}

      {/* Settings Dialog */}
      {enableModelSelection && availableModels.length > 0 && (
        <ChatSettingsDialog
          open={settingsDialogOpen}
          onClose={handleSettingsClose}
          currentModel={chat.model}
          onModelChange={handleModelChange}
          availableModels={availableModels}
          cheapModels={cheapModels}
        />
      )}

      {/* Hidden File Input for Upload — disabled with JSON upload feature */}
      {/*
      {enableExport && (
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          accept=".json"
          onChange={handleFileChange}
        />
      )}
      */}
    </Box>
  );
}

export default ChatPanel;
